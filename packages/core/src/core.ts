import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeBase64Url,
  PROTOCOL_VERSION,
  type ManualPresenceState,
  type ProfileEdit,
} from '@officemesh/protocol';
import type {
  AppInfo,
  ConversationView,
  IdentityView,
  IpcEventName,
  IpcEventPayload,
  MessageView,
  NetworkStatus,
  PersonView,
  PresenceView,
} from '@officemesh/protocol/ipc';
import { editProfile } from './identity/profile.ts';
import { loadOrCreateIdentity, type Identity } from './identity/identity.ts';
import { defaultDisplayName } from './identity/system-name.ts';
import type { Clock, DiscoveryDriver, KeyProtector, Logger, Transport } from './interfaces.ts';
import { PeerNetwork } from './network.ts';
import type { Peer } from './peers/directory.ts';
import { PresenceService } from './peers/presence.ts';
import { createConsoleLogger, systemClock } from './platform.ts';
import {
  ConversationRepo,
  type ConversationSummaryRow,
  type MessageRow,
} from './store/conversations.ts';
import { Store } from './store/store.ts';
import { HybridClock } from './sync/hlc.ts';

export const DATABASE_FILE_NAME = 'officemesh.db';

/** Things only the host process (Electron main) can do. */
export interface HostServices {
  /** Add the Windows Firewall rules; prompts for elevation. Resolves when the attempt ends. */
  fixFirewall(): Promise<void>;
  openNetworkSettings(): void;
}

export interface CoreNetworkOptions {
  discovery: DiscoveryDriver;
  /** Built once the identity (key and certificate) is loaded. */
  transport: (identity: Identity) => Transport;
}

export interface CoreOptions {
  /** Profile folder: holds the database and the sealed identity key. */
  dataDir: string;
  profile: string;
  appVersion: string;
  keyProtector: KeyProtector;
  clock?: Clock;
  logger?: Logger;
  /** Display name for a new identity; defaults to the Windows account's full name. */
  defaultDisplayName?: () => Promise<string>;
  /** Discovery and peer links. Without it the core runs offline (identity and store only). */
  network?: CoreNetworkOptions;
  host?: HostServices;
}

export type CoreEventListener = <N extends IpcEventName>(
  name: N,
  payload: IpcEventPayload<N>,
) => void;

export class NotAvailableError extends Error {}

/** One peer's core: identity, store, presence, discovery, links and sync. */
export class Core {
  readonly identity: Identity;
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly presence: PresenceService;
  readonly conversations: ConversationRepo;
  readonly hlc: HybridClock;
  network: PeerNetwork | undefined;
  private readonly options: CoreOptions;
  private readonly listeners = new Set<CoreEventListener>();
  private hostStatus: Pick<NetworkStatus, 'firewall' | 'publicNetwork'> = {
    firewall: 'checking',
    publicNetwork: false,
  };
  private lastNetworkStatus = '';
  private closed = false;

  private constructor(
    options: CoreOptions,
    store: Store,
    identity: Identity,
    clock: Clock,
    logger: Logger,
  ) {
    this.options = options;
    this.store = store;
    this.identity = identity;
    this.clock = clock;
    this.logger = logger;
    this.presence = new PresenceService(store);
    this.conversations = new ConversationRepo(store.db);
    this.hlc = new HybridClock(clock);
  }

  static async start(options: CoreOptions): Promise<Core> {
    const clock = options.clock ?? systemClock;
    const logger = options.logger ?? createConsoleLogger(`core:${options.profile}`);
    mkdirSync(options.dataDir, { recursive: true });
    const store = Store.open(join(options.dataDir, DATABASE_FILE_NAME));
    let core: Core | undefined;
    try {
      const identity = await loadOrCreateIdentity({
        store,
        dataDir: options.dataDir,
        protector: options.keyProtector,
        clock,
        logger,
        defaultDisplayName: options.defaultDisplayName ?? (() => defaultDisplayName()),
      });
      core = new Core(options, store, identity, clock, logger);
      if (options.network) await core.startNetwork(options.network);
      logger.info('core started', {
        userId: identity.userId,
        profile: options.profile,
        linkPort: core.network?.linkPort,
      });
      return core;
    } catch (err) {
      if (core) await core.close();
      else store.close();
      throw err;
    }
  }

  private async startNetwork(net: CoreNetworkOptions): Promise<void> {
    const network = new PeerNetwork({
      identity: this.identity,
      store: this.store,
      conversations: this.conversations,
      presence: this.presence,
      hlc: this.hlc,
      clock: this.clock,
      logger: this.logger,
      appVersion: this.options.appVersion,
      discovery: net.discovery,
      transport: net.transport(this.identity),
      syncEvents: {
        messagesAdded: (convId, rows) =>
          this.emit('messages.added', { convId, messages: rows.map((r) => this.messageView(r)) }),
        messagesStatusChanged: (convId, rows) =>
          this.emit('messages.updated', { convId, messages: rows.map((r) => this.messageView(r)) }),
        conversationsChanged: (convIds) => this.emitConversations(convIds),
      },
      onPeerOnlineChanged: (peer) => this.onPeerOnlineChanged(peer),
      onStatusChanged: () => this.emitNetworkStatusIfChanged(),
    });
    this.network = network;
    network.directory.onChange((ids) => {
      const people = ids.flatMap((id) => {
        const peer = network.directory.get(id);
        return peer ? [network.directory.view(peer)] : [];
      });
      this.emit('people.changed', { people });
      this.emitNetworkStatusIfChanged();
    });
    this.presence.onChange((view) => {
      this.emit('presence.changed', view);
      network.announce();
    });
    await network.start();
  }

  get userId(): string {
    return this.identity.userId;
  }

  private requireNetwork(): PeerNetwork {
    if (!this.network) throw new NotAvailableError('networking is not running');
    return this.network;
  }

  // -------------------------------------------------------------------------
  // Identity and presence
  // -------------------------------------------------------------------------

  identityView(): IdentityView {
    const { identity } = this;
    const { profile } = identity;
    return {
      userId: identity.userId,
      publicKey: encodeBase64Url(identity.spki),
      displayName: profile.displayName,
      ...(profile.jobTitle !== undefined && { jobTitle: profile.jobTitle }),
      ...(profile.statusMessage !== undefined && { statusMessage: profile.statusMessage }),
      profileVersion: profile.version,
      safetyPhrase: identity.safetyPhrase,
      createdAt: identity.createdAt,
    };
  }

  appInfo(): AppInfo {
    return {
      appVersion: this.options.appVersion,
      protocolVersion: PROTOCOL_VERSION,
      profile: this.options.profile,
      dataDir: this.options.dataDir,
      keyProtection: this.options.keyProtector.scheme,
    };
  }

  updateProfile(edit: ProfileEdit): IdentityView {
    const next = editProfile(
      this.identity.privateKey,
      this.identity.profile,
      edit,
      this.clock.now(),
    );
    this.store.updateProfileJson(JSON.stringify(next));
    this.identity.profile = next;
    const view = this.identityView();
    this.emit('identity.changed', view);
    this.network?.announce();
    return view;
  }

  presenceView(): PresenceView {
    return this.presence.view();
  }

  setPresence(state: ManualPresenceState): PresenceView {
    return this.presence.setManual(state);
  }

  /** Idle and lock state from the host (Electron powerMonitor). */
  setSystemState(state: { idle?: boolean; locked?: boolean }): void {
    this.presence.setSystem(state);
  }

  /** The PC is about to sleep or has woken. */
  setPower(event: 'suspend' | 'resume'): void {
    if (event === 'suspend') this.network?.suspend();
    else this.network?.resume();
  }

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------

  people(): PersonView[] {
    const network = this.network;
    if (!network) return [];
    return network.directory.all().map((p) => network.directory.view(p));
  }

  setPeerTrust(userId: string, change: { accept?: boolean; verified?: boolean }): PersonView {
    const network = this.requireNetwork();
    const peer = network.directory.setTrust(userId, change);
    if (!peer) throw new NotAvailableError('unknown person');
    return network.directory.view(peer);
  }

  private onPeerOnlineChanged(peer: Peer): void {
    const network = this.network;
    if (!network) return;
    // Own undelivered messages to this peer switch between "sending" and "waiting".
    if (!network.sync.hasPendingFor(peer.userId)) return;
    const convId = network.sync.directConvId(peer.userId);
    const head = this.conversations.head(convId, this.userId);
    const acked = this.conversations.getAck(convId, peer.userId, this.userId);
    if (head > acked) {
      const rows = this.conversations.messagesByAuthorRange(convId, this.userId, acked + 1, head);
      this.emit('messages.updated', { convId, messages: rows.map((r) => this.messageView(r)) });
    }
  }

  // -------------------------------------------------------------------------
  // Conversations and messages
  // -------------------------------------------------------------------------

  private conversationView(row: ConversationSummaryRow): ConversationView {
    const peer = row.peerUserId ? this.network?.directory.get(row.peerUserId) : undefined;
    return {
      convId: row.convId,
      kind: row.kind,
      ...(row.peerUserId && { peerUserId: row.peerUserId }),
      title: peer?.profile?.displayName ?? 'Unknown colleague',
      ...(row.lastAuthor !== null &&
        row.lastText !== null &&
        row.lastAt !== null && {
          lastMessage: { author: row.lastAuthor, text: row.lastText.slice(0, 200), at: row.lastAt },
        }),
      lastActivityAt: row.lastActivity,
    };
  }

  conversationList(): ConversationView[] {
    return this.conversations.list().map((r) => this.conversationView(r));
  }

  private emitConversations(convIds: string[]): void {
    const wanted = new Set(convIds);
    const conversations = this.conversations
      .list()
      .filter((r) => wanted.has(r.convId))
      .map((r) => this.conversationView(r));
    if (conversations.length > 0) this.emit('conversations.changed', { conversations });
  }

  openDirect(userId: string): ConversationView {
    const network = this.requireNetwork();
    if (!network.directory.get(userId)) throw new NotAvailableError('unknown person');
    const row = network.sync.openDirect(userId);
    const summary = this.conversations.list().find((r) => r.convId === row.convId)!;
    return this.conversationView(summary);
  }

  messageView(row: MessageRow): MessageView {
    const mine = row.author === this.userId;
    return {
      id: `${row.author}:${row.seq}`,
      convId: row.convId,
      author: row.author,
      seq: row.seq,
      hlc: { t: row.hlcT, c: row.hlcC },
      at: row.hlcT,
      text: row.text,
      mine,
      ...(mine && this.network && { status: this.network.sync.status(row.convId, row.seq) }),
    };
  }

  listMessages(
    convId: string,
    limit = 100,
    before?: { hlc: { t: number; c: number }; author: string },
  ): MessageView[] {
    if (!this.conversations.get(convId)) throw new NotAvailableError('unknown conversation');
    return this.conversations.messages(convId, limit, before).map((r) => this.messageView(r));
  }

  sendMessage(convId: string, text: string): MessageView {
    const row = this.requireNetwork().sync.post(convId, text);
    return this.messageView(row);
  }

  // -------------------------------------------------------------------------
  // Network status
  // -------------------------------------------------------------------------

  networkStatus(): NetworkStatus {
    return {
      ...this.hostStatus,
      discovery: this.network ? 'ok' : 'off',
      linkPort: this.network?.linkPort ?? null,
      onlinePeers: this.network?.directory.onlineCount() ?? 0,
      clockSkewPeers: this.network?.clockSkewPeers ?? 0,
    };
  }

  /** Firewall and network-category findings from the host. */
  setHostNetworkStatus(status: Pick<NetworkStatus, 'firewall' | 'publicNetwork'>): void {
    this.hostStatus = status;
    this.emitNetworkStatusIfChanged();
  }

  async fixFirewall(): Promise<NetworkStatus> {
    if (!this.options.host) throw new NotAvailableError('not available in this host');
    await this.options.host.fixFirewall();
    return this.networkStatus();
  }

  openNetworkSettings(): void {
    this.options.host?.openNetworkSettings();
  }

  private emitNetworkStatusIfChanged(): void {
    const status = this.networkStatus();
    const key = JSON.stringify(status);
    if (key === this.lastNetworkStatus) return;
    this.lastNetworkStatus = key;
    this.emit('network.changed', status);
  }

  // -------------------------------------------------------------------------
  // Events and lifecycle
  // -------------------------------------------------------------------------

  onEvent(listener: CoreEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit<N extends IpcEventName>(name: N, payload: IpcEventPayload<N>): void {
    for (const listener of this.listeners) {
      try {
        listener(name, payload);
      } catch (err) {
        this.logger.error('event listener failed', { name, err: String(err) });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.network?.stop();
    } catch (err) {
      this.logger.warn('network stop failed', { err: String(err) });
    }
    this.listeners.clear();
    this.store.close();
    this.logger.info('core stopped');
  }
}

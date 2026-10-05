import { mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  encodeBase64Url,
  MAX_AVATAR_BYTES,
  PROTOCOL_VERSION,
  type FileRef,
  type LinkPreview,
  type ManualPresenceState,
  type MsgRef,
  type ProfileEdit,
} from '@officemesh/protocol';
import type {
  ActivityItem,
  AppInfo,
  ConversationView,
  FileStatus,
  IdentityView,
  IpcEventName,
  IpcEventPayload,
  MessageView,
  NetworkStatus,
  PersonView,
  PresenceView,
  SearchHit,
  Settings,
} from '@officemesh/protocol/ipc';
import { FileStore } from './files/store.ts';
import { isExecutable } from './files/names.ts';
import { TransferManager } from './files/transfer.ts';
import { sha256 } from './identity/crypto.ts';
import { editProfile } from './identity/profile.ts';
import { loadOrCreateIdentity, type Identity } from './identity/identity.ts';
import { defaultDisplayName } from './identity/system-name.ts';
import type {
  Clock,
  DiscoveryDriver,
  KeyProtector,
  Logger,
  TimerHandle,
  Transport,
} from './interfaces.ts';
import { fetchLanPreview } from './links/preview.ts';
import { PeerNetwork } from './network.ts';
import type { Peer } from './peers/directory.ts';
import { PresenceService } from './peers/presence.ts';
import { createConsoleLogger, systemClock } from './platform.ts';
import { ConversationRepo, type ConversationSummaryRow } from './store/conversations.ts';
import { MessageRepo, type MessageRow } from './store/messages.ts';
import { Store } from './store/store.ts';
import { HybridClock } from './sync/hlc.ts';
import { excerpt, mentionIds } from './sync/markdown.ts';
import type { Effects } from './sync/materialize.ts';

export const DATABASE_FILE_NAME = 'officemesh.db';

/** Images below this size download as soon as they are shared (plan section 10). */
const AUTO_DOWNLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
const PASTE_LIMIT_BYTES = 25 * 1024 * 1024;
/** At most one read receipt per conversation in this window. */
const RECEIPT_THROTTLE_MS = 2_000;

export interface Toast {
  /** Stable per message, so a repeat replaces rather than stacks. */
  id: string;
  convId: string;
  target: MsgRef;
  title: string;
  body: string;
  urgent: boolean;
}

/** Things only the host process (Electron main) can do. */
export interface HostServices {
  /** Add the Windows Firewall rules; prompts for elevation. Resolves when the attempt ends. */
  fixFirewall(): Promise<void>;
  openNetworkSettings(): void;
  notify?(toast: Toast): void;
  /** Total unread, for the taskbar badge and tray tooltip. */
  setBadge?(count: number): void;
  openPath?(path: string): void;
  showInFolder?(path: string): void;
  snip?(): void;
  setStartWithWindows?(enabled: boolean): void;
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
  /** Shared, content-addressed file store (default `<dataDir>/../files`). */
  filesDir?: string;
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

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

/** One peer's core: identity, store, presence, discovery, links, sync and files. */
export class Core {
  readonly identity: Identity;
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly presence: PresenceService;
  readonly conversations: ConversationRepo;
  readonly messages: MessageRepo;
  readonly files: FileStore;
  readonly hlc: HybridClock;
  network: PeerNetwork | undefined;
  transfers: TransferManager | undefined;
  private readonly options: CoreOptions;
  private readonly listeners = new Set<CoreEventListener>();
  private hostStatus: Pick<NetworkStatus, 'firewall' | 'publicNetwork'> = {
    firewall: 'checking',
    publicNetwork: false,
  };
  private lastNetworkStatus = '';
  private ui: { activeConvId: string | null; windowFocused: boolean } = {
    activeConvId: null,
    windowFocused: false,
  };
  private lastBadge = -1;
  private readonly receiptTimers = new Map<string, TimerHandle>();
  private statusTimer: TimerHandle | undefined;
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
    this.messages = new MessageRepo(store.db);
    this.files = new FileStore(options.filesDir ?? join(options.dataDir, '..', 'files'), store.db);
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
      await core.files.init();
      if (options.network) await core.startNetwork(options.network);
      core.statusTimer = clock.setInterval(() => core!.expireStatus(), 60_000);
      core.expireStatus();
      options.host?.setStartWithWindows?.(core.settings().startWithWindows);
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
      messages: this.messages,
      avatarDir: join(this.files.dir, 'avatars'),
      presence: this.presence,
      hlc: this.hlc,
      clock: this.clock,
      logger: this.logger,
      appVersion: this.options.appVersion,
      discovery: net.discovery,
      transport: net.transport(this.identity),
      syncEvents: {
        effects: (fx, local) => this.onEffects(fx, local),
        statusChanged: (convId, refs) => this.emitMessages('messages.updated', convId, refs),
        conversationsChanged: (convIds) => this.emitConversations(convIds),
        typing: (convId, userId) => this.emit('typing', { convId, userId }),
      },
      onPeerOnlineChanged: (peer) => this.onPeerOnlineChanged(peer),
      onStatusChanged: () => this.emitNetworkStatusIfChanged(),
    });
    this.network = network;
    this.transfers = new TransferManager({
      store: this.files,
      links: network.links,
      clock: this.clock,
      logger: this.logger,
      selfId: this.userId,
      membersFor: (sha) => this.fileMembers(sha).filter((u) => u !== this.userId),
      mayServe: (sha, userId) => this.fileMembers(sha).includes(userId),
      isOnline: (userId) => network.directory.get(userId)?.online === true,
      dial: (userId) => network.dial(userId),
      progress: (status) => this.emit('files.progress', status),
      completed: () => {},
    });
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
  // Identity, presence, settings
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
      ...(profile.statusExpiresAt !== undefined && { statusExpiresAt: profile.statusExpiresAt }),
      ...(profile.avatarHash !== undefined && { avatarHash: profile.avatarHash }),
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

  async setAvatar(
    data: Uint8Array,
    mime: 'image/png' | 'image/jpeg' | 'image/webp',
  ): Promise<IdentityView> {
    if (data.length > MAX_AVATAR_BYTES) throw new NotAvailableError('avatar image is too large');
    const hash = sha256(data).toString('hex');
    if (!(await this.requireNetwork().saveAvatar(hash, mime, data)))
      throw new NotAvailableError('avatar could not be saved');
    return this.updateProfile({ avatarHash: hash });
  }

  /** Clear an own status message once its expiry passes (peers then fetch the new profile). */
  private expireStatus(): void {
    const exp = this.identity.profile.statusExpiresAt;
    if (exp !== undefined && exp <= this.clock.now())
      this.updateProfile({ statusMessage: '', statusExpiresAt: null });
  }

  presenceView(): PresenceView {
    return this.presence.view();
  }

  setPresence(state: ManualPresenceState): PresenceView {
    return this.presence.setManual(state);
  }

  setSystemState(state: { idle?: boolean; locked?: boolean }): void {
    this.presence.setSystem(state);
  }

  setPower(event: 'suspend' | 'resume'): void {
    if (event === 'suspend') this.network?.suspend();
    else this.network?.resume();
  }

  settings(): Settings {
    return {
      readReceipts: this.store.getSetting<boolean>('privacy.readReceipts') ?? true,
      startWithWindows: this.store.getSetting<boolean>('app.startWithWindows') ?? true,
    };
  }

  setSettings(change: Partial<Settings>): Settings {
    if (change.readReceipts !== undefined)
      this.store.setSetting('privacy.readReceipts', change.readReceipts);
    if (change.startWithWindows !== undefined) {
      this.store.setSetting('app.startWithWindows', change.startWithWindows);
      this.options.host?.setStartWithWindows?.(change.startWithWindows);
    }
    const next = this.settings();
    this.emit('settings.changed', next);
    return next;
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

  private nameOf(userId: string): string {
    if (userId === this.userId) return this.identity.profile.displayName;
    return this.network?.directory.get(userId)?.profile?.displayName ?? 'A colleague';
  }

  private onPeerOnlineChanged(peer: Peer): void {
    const network = this.network;
    if (!network) return;
    if (peer.online) this.transfers?.pumpAll();
    if (!network.sync.hasPendingFor(peer.userId)) return;
    // Own undelivered messages to this peer switch between "sending" and "waiting".
    const convId = network.sync.directConvId(peer.userId);
    const head = this.conversations.head(convId, this.userId);
    const acked = this.conversations.getAck(convId, peer.userId, this.userId);
    if (head > acked) {
      const rows = this.messages.byAuthorSeqRange(convId, this.userId, acked + 1, head);
      this.emitMessages(
        'messages.updated',
        convId,
        rows.map((r) => ({ author: r.author, seq: r.seq })),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Conversations and message views
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
      unread: this.messages.unread(row.convId, this.userId),
      notify:
        this.messages.notifyLevel(row.convId) ?? (row.kind === 'channel' ? 'mentions' : 'all'),
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
    this.updateBadge();
  }

  openDirect(userId: string): ConversationView {
    const network = this.requireNetwork();
    if (!network.directory.get(userId)) throw new NotAvailableError('unknown person');
    const row = network.sync.openDirect(userId);
    return this.conversationView(this.conversations.list().find((r) => r.convId === row.convId)!);
  }

  private messageViews(convId: string, rows: MessageRow[]): MessageView[] {
    const refs = rows.map((r) => ({ author: r.author, seq: r.seq }));
    const reactions = this.messages.reactions(convId, refs);
    const pinned = new Set(this.messages.pinned(convId).map((p) => `${p.author}:${p.seq}`));
    return rows.map((row) => {
      const key = `${row.author}:${row.seq}`;
      const body = JSON.parse(row.bodyJson) as {
        mentions?: string[];
        replyTo?: MsgRef;
        forwarded?: { from: string; at: number };
        file?: FileRef;
        preview?: LinkPreview;
      };
      const byEmoji = new Map<string, string[]>();
      for (const r of reactions) {
        if (r.targetAuthor !== row.author || r.targetSeq !== row.seq) continue;
        byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.userId]);
      }
      let replyTo: MessageView['replyTo'];
      if (body.replyTo) {
        const quoted = this.messages.get(convId, body.replyTo);
        replyTo = {
          ...body.replyTo,
          excerpt: quoted ? (quoted.deleted ? '' : excerpt(quoted.text || quoted.plain)) : '',
          missing: !quoted || quoted.deleted === 1,
        };
      }
      const mine = row.author === this.userId;
      return {
        id: key,
        convId,
        author: row.author,
        seq: row.seq,
        hlc: { t: row.hlcT, c: row.hlcC },
        at: row.hlcT,
        kind: row.kind,
        text: row.deleted ? '' : row.text,
        mine,
        ...(mine &&
          this.network && {
            status: this.network.sync.status(convId, row.seq, { t: row.hlcT, c: row.hlcC }),
          }),
        mentions: body.mentions ?? [],
        mentionsMe: row.mentionsMe === 1,
        urgent: row.urgent === 1,
        edited: row.editedT !== null,
        deleted: row.deleted === 1,
        pinned: pinned.has(key),
        saved: this.messages.isSaved(convId, row),
        ...(replyTo && { replyTo }),
        ...(body.forwarded && !row.deleted && { forwarded: body.forwarded }),
        ...(body.file && !row.deleted && { file: body.file }),
        ...(body.preview && !row.deleted && { preview: body.preview }),
        reactions: row.deleted
          ? []
          : [...byEmoji].map(([emoji, users]) => ({
              emoji,
              users,
              mine: users.includes(this.userId),
            })),
      };
    });
  }

  private view(convId: string, ref: MsgRef): MessageView {
    const row = this.messages.get(convId, ref);
    if (!row) throw new NotAvailableError('unknown message');
    return this.messageViews(convId, [row])[0]!;
  }

  private emitMessages(
    name: 'messages.added' | 'messages.updated',
    convId: string,
    refs: MsgRef[],
  ): void {
    if (refs.length === 0) return;
    const rows = this.messages.byKeys(convId, refs);
    if (rows.length > 0) this.emit(name, { convId, messages: this.messageViews(convId, rows) });
  }

  listMessages(
    convId: string,
    limit = 100,
    before?: { hlc: { t: number; c: number }; author: string },
  ): MessageView[] {
    if (!this.conversations.get(convId)) throw new NotAvailableError('unknown conversation');
    return this.messageViews(convId, this.messages.list(convId, limit, before));
  }

  messageContext(convId: string, target: MsgRef): MessageView[] {
    return this.messageViews(convId, this.messages.context(convId, target, 50));
  }

  pinnedMessages(convId: string): MessageView[] {
    return this.messageViews(convId, this.messages.byKeys(convId, this.messages.pinned(convId)));
  }

  savedMessages(): MessageView[] {
    return this.messages.saved().flatMap((s) => {
      const row = this.messages.get(s.convId, s);
      return row ? this.messageViews(s.convId, [row]) : [];
    });
  }

  // -------------------------------------------------------------------------
  // Message actions
  // -------------------------------------------------------------------------

  sendMessage(
    convId: string,
    text: string,
    extra: {
      mentions?: string[] | undefined;
      replyTo?: MsgRef | undefined;
      urgent?: boolean | undefined;
      preview?: LinkPreview | undefined;
    } = {},
  ): MessageView {
    if (!text.trim()) throw new NotAvailableError('message is empty');
    const mentions = extra.mentions ?? mentionIds(text);
    const ref = this.requireNetwork().sync.append(convId, 'msg.post', {
      text,
      ...(mentions.length > 0 && { mentions }),
      ...(extra.replyTo && { replyTo: extra.replyTo }),
      ...(extra.urgent && { urgent: true }),
      ...(extra.preview && { preview: extra.preview }),
    });
    this.markRead(convId);
    return this.view(convId, ref);
  }

  private ownMessage(convId: string, target: MsgRef): MessageRow {
    const row = this.messages.get(convId, target);
    if (!row) throw new NotAvailableError('unknown message');
    if (row.author !== this.userId)
      throw new NotAvailableError('you can only change your own messages');
    if (row.deleted) throw new NotAvailableError('message was deleted');
    return row;
  }

  editMessage(convId: string, target: MsgRef, text: string, mentions?: string[]): MessageView {
    this.ownMessage(convId, target);
    if (!text.trim()) throw new NotAvailableError('message is empty');
    const ids = mentions ?? mentionIds(text);
    this.requireNetwork().sync.append(convId, 'msg.edit', {
      target,
      text,
      ...(ids.length > 0 && { mentions: ids }),
    });
    return this.view(convId, target);
  }

  deleteMessage(convId: string, target: MsgRef): MessageView {
    this.ownMessage(convId, target);
    this.requireNetwork().sync.append(convId, 'msg.delete', { target });
    return this.view(convId, target);
  }

  react(convId: string, target: MsgRef, emoji: string, on: boolean): MessageView {
    this.view(convId, target);
    this.requireNetwork().sync.append(convId, on ? 'msg.react' : 'msg.unreact', { target, emoji });
    return this.view(convId, target);
  }

  pin(convId: string, target: MsgRef, on: boolean): MessageView {
    this.view(convId, target);
    this.requireNetwork().sync.append(convId, on ? 'msg.pin' : 'msg.unpin', { target });
    return this.view(convId, target);
  }

  save(convId: string, target: MsgRef, on: boolean): MessageView {
    this.view(convId, target);
    this.messages.setSaved(convId, target, on, this.clock.now());
    const view = this.view(convId, target);
    this.emit('messages.updated', { convId, messages: [view] });
    return view;
  }

  forward(convId: string, target: MsgRef, toConvId: string): MessageView {
    const source = this.messages.get(convId, target);
    if (!source || source.deleted) throw new NotAvailableError('unknown message');
    const body = JSON.parse(source.bodyJson) as { file?: FileRef };
    const sync = this.requireNetwork().sync;
    const forwarded = { from: this.nameOf(source.author), at: source.hlcT };
    const ref = body.file
      ? sync.append(toConvId, 'file.share', {
          file: body.file,
          ...(source.text && { text: source.text }),
        })
      : sync.append(toConvId, 'msg.post', { text: source.text, forwarded });
    return this.view(toConvId, ref);
  }

  sendTyping(convId: string): void {
    this.network?.sync.sendTyping(convId);
  }

  // -------------------------------------------------------------------------
  // Read state, notifications, activity
  // -------------------------------------------------------------------------

  setUiState(state: { activeConvId: string | null; windowFocused: boolean }): void {
    this.ui = state;
    if (state.activeConvId && state.windowFocused) this.markRead(state.activeConvId);
  }

  /** Mark a conversation read to its newest message, and send a read receipt if allowed. */
  markRead(convId: string): void {
    const conv = this.conversations.get(convId);
    const latest = this.messages.latest(convId);
    if (!conv || !latest) return;
    const hadUnread = this.messages.unread(convId, this.userId) > 0;
    this.messages.setReadState(convId, { t: latest.hlcT, c: latest.hlcC });
    if (hadUnread) {
      this.emitConversations([convId]);
      // Read receipts: direct chats only until groups (M3), and only if the user allows them.
      if (this.settings().readReceipts && conv.kind === 'direct') this.scheduleReceipt(convId);
    }
  }

  private scheduleReceipt(convId: string): void {
    if (this.receiptTimers.has(convId)) return;
    const sent = this.messages.readState(convId)?.receiptSentT ?? 0;
    const wait = Math.max(0, sent + RECEIPT_THROTTLE_MS - this.clock.now());
    const fire = () => {
      this.receiptTimers.delete(convId);
      const rs = this.messages.readState(convId);
      if (!rs || !this.network) return;
      this.network.sync.append(convId, 'msg.read', { upto: rs.hlc });
      this.messages.setReceiptSent(convId, this.clock.now());
    };
    if (wait === 0) fire();
    else this.receiptTimers.set(convId, this.clock.setTimeout(fire, wait));
  }

  private onEffects(fx: Effects, local: boolean): void {
    for (const [convId, { refs, added }] of fx.changed) {
      const addedKeys = new Set(added.map((r) => `${r.author}:${r.seq}`));
      const updated = refs.filter((r) => !addedKeys.has(`${r.author}:${r.seq}`));
      this.emitMessages('messages.added', convId, added);
      this.emitMessages('messages.updated', convId, updated);
      for (const ref of added) this.noteFile(convId, ref, !local);
    }
    if (fx.activity.length > 0) this.emitActivity();
    for (const { convId, row } of fx.incoming) this.considerToast(convId, row);
    if (!local) this.updateBadge();
  }

  /** Remember shared files; images under 10 MB from others download right away. */
  private noteFile(convId: string, ref: MsgRef, incoming: boolean): void {
    const row = this.messages.get(convId, ref);
    if (!row || row.kind !== 'file') return;
    const file = (JSON.parse(row.bodyJson) as { file?: FileRef }).file;
    if (!file) return;
    this.files.note(file, convId, this.clock.now());
    if (incoming && file.mime.startsWith('image/') && file.size < AUTO_DOWNLOAD_IMAGE_BYTES) {
      this.transfers?.download(file);
    }
  }

  private considerToast(convId: string, row: MessageRow): void {
    const viewing = this.ui.windowFocused && this.ui.activeConvId === convId;
    if (viewing) {
      this.markRead(convId);
      return;
    }
    const conv = this.conversations.get(convId);
    if (!conv) return;
    const level =
      this.messages.notifyLevel(convId) ?? (conv.kind === 'channel' ? 'mentions' : 'all');
    const body = JSON.parse(row.bodyJson) as { replyTo?: MsgRef; file?: FileRef };
    const personal = row.mentionsMe === 1 || body.replyTo?.author === this.userId;
    const urgent = row.urgent === 1;
    if (level === 'muted' && !urgent) return;
    if (level === 'mentions' && !personal && !urgent) return;
    // Do not disturb lets urgent messages through only (plan section 6).
    if (this.presence.view().manual === 'dnd' && !urgent) return;
    const text =
      row.kind === 'file'
        ? `📎 ${body.file?.name ?? 'File'}${row.text ? ` — ${excerpt(row.text, 100)}` : ''}`
        : excerpt(row.text, 160);
    this.options.host?.notify?.({
      id: `${convId}:${row.author}:${row.seq}`,
      convId,
      target: { author: row.author, seq: row.seq },
      title: `${urgent ? 'URGENT: ' : ''}${this.nameOf(row.author)}`,
      body: text,
      urgent,
    });
  }

  totalUnread(): number {
    return this.conversations
      .list()
      .filter((c) => this.messages.notifyLevel(c.convId) !== 'muted')
      .reduce((n, c) => n + this.messages.unread(c.convId, this.userId), 0);
  }

  private updateBadge(): void {
    const total = this.totalUnread();
    if (total === this.lastBadge) return;
    this.lastBadge = total;
    this.options.host?.setBadge?.(total);
  }

  /** A reply typed into a toast (the window may stay hidden). */
  replyFromToast(convId: string, text: string): MessageView {
    return this.sendMessage(convId, text);
  }

  openFromToast(convId: string, target?: MsgRef): void {
    this.emit('ui.open', { convId, ...(target && { target }) });
  }

  setNotifyLevel(convId: string, level: 'all' | 'mentions' | 'muted'): ConversationView {
    if (!this.conversations.get(convId)) throw new NotAvailableError('unknown conversation');
    this.messages.setNotifyLevel(convId, level);
    this.updateBadge();
    return this.conversationView(this.conversations.list().find((r) => r.convId === convId)!);
  }

  activity(): ActivityItem[] {
    return this.messages.activity().map((a) => {
      const target = { author: a.targetAuthor, seq: a.targetSeq };
      const source = this.messages.get(
        a.convId,
        a.kind === 'reaction' ? target : { author: a.author, seq: a.sourceSeq },
      );
      return {
        id: a.id,
        kind: a.kind,
        convId: a.convId,
        author: a.author,
        target: a.kind === 'reaction' ? target : { author: a.author, seq: a.sourceSeq },
        excerpt: source && !source.deleted ? excerpt(source.text || source.plain, 140) : '',
        ...(a.emoji && { emoji: a.emoji }),
        at: a.at,
        read: a.read === 1,
      };
    });
  }

  markActivityRead(ids?: number[]): void {
    this.messages.markActivityRead(ids);
    this.emitActivity();
  }

  private emitActivity(): void {
    this.emit('activity.changed', {
      items: this.activity(),
      unread: this.messages.unreadActivity(),
    });
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  /** Everyone in a conversation where the file was shared may fetch it from this PC. */
  private fileMembers(sha: string): string[] {
    return this.store.db
      .prepare(
        `SELECT DISTINCT mb.user_id FROM messages m JOIN members mb ON mb.conv_id = m.conv_id
          WHERE m.kind = 'file' AND m.deleted = 0 AND json_extract(m.body_json, '$.file.sha256') = ?`,
      )
      .pluck()
      .all(sha) as string[];
  }

  async shareFile(input: {
    convId: string;
    path?: string | undefined;
    data?: Uint8Array | undefined;
    name?: string | undefined;
    mime?: string | undefined;
    text?: string | undefined;
    mentions?: string[] | undefined;
    replyTo?: MsgRef | undefined;
    urgent?: boolean | undefined;
    thumb?: string | undefined;
    width?: number | undefined;
    height?: number | undefined;
  }): Promise<MessageView> {
    const sync = this.requireNetwork().sync;
    if (!this.conversations.get(input.convId)) throw new NotAvailableError('unknown conversation');
    const now = this.clock.now();
    const name = (
      input.name ??
      (input.path ? input.path.split(/[\\/]/).pop() : undefined) ??
      'file'
    ).slice(0, 255);
    const mime =
      input.mime || MIME_BY_EXT[extname(name).toLowerCase()] || 'application/octet-stream';
    let ref: FileRef;
    if (input.data) {
      if (input.data.length > PASTE_LIMIT_BYTES)
        throw new NotAvailableError('pasted data is too large; attach the file instead');
      ref = await this.files.importBytes(input.data, name, mime, input.convId, now);
    } else if (input.path) {
      ref = await this.files.importPath(input.path, name, mime, input.convId, now);
    } else {
      throw new NotAvailableError('nothing to share');
    }
    const thumb = input.thumb && /^[A-Za-z0-9_-]+$/.test(input.thumb) ? input.thumb : undefined;
    const file: FileRef = {
      ...ref,
      ...(thumb && { thumb }),
      ...(input.width && { width: input.width }),
      ...(input.height && { height: input.height }),
    };
    const text = input.text?.trim() ? input.text : undefined;
    const mentions = input.mentions ?? (text ? mentionIds(text) : []);
    const msg = sync.append(input.convId, 'file.share', {
      file,
      ...(text && { text }),
      ...(mentions.length > 0 && { mentions }),
      ...(input.replyTo && { replyTo: input.replyTo }),
      ...(input.urgent && { urgent: true }),
    });
    return this.view(input.convId, msg);
  }

  fileStatus(sha: string): FileStatus {
    return (
      this.transfers?.status(sha) ?? {
        sha256: sha,
        state: this.files.isComplete(sha) ? 'complete' : 'missing',
        received: 0,
        size: 0,
      }
    );
  }

  downloadFile(sha: string): FileStatus {
    const row = this.files.row(sha);
    if (!row || !this.transfers) throw new NotAvailableError('unknown file');
    return this.transfers.download({
      sha256: sha,
      name: row.name,
      size: row.size,
      mime: row.mime,
      manifest: row.manifest,
    });
  }

  async cancelDownload(sha: string): Promise<FileStatus> {
    if (!this.transfers) throw new NotAvailableError('networking is not running');
    return this.transfers.cancel(sha);
  }

  /** Open with the default app; executables are only ever shown in Explorer. */
  async openFile(sha: string, reveal = false): Promise<void> {
    const path = await this.files.openablePath(sha);
    const row = this.files.row(sha)!;
    if (reveal || isExecutable(row.name)) this.options.host?.showInFolder?.(path);
    else this.options.host?.openPath?.(path);
  }

  async linkPreview(url: string): Promise<LinkPreview | null> {
    return fetchLanPreview(url);
  }

  snip(): void {
    this.options.host?.snip?.();
  }

  // -------------------------------------------------------------------------
  // Search and rebuild
  // -------------------------------------------------------------------------

  search(q: {
    text: string;
    from?: string | undefined;
    convId?: string | undefined;
    hasFile?: boolean | undefined;
    after?: number | undefined;
    before?: number | undefined;
    limit?: number | undefined;
  }): { messages: SearchHit[]; tookMs: number } {
    const started = performance.now();
    // Each word must match, as a prefix; quotes and FTS syntax are neutralised.
    const tokens = q.text
      .split(/\s+/)
      .map((t) => t.replace(/["*^:()]/g, '').trim())
      .filter(Boolean)
      .slice(0, 8);
    const match = tokens.length > 0 ? tokens.map((t) => `"${t}"*`).join(' ') : undefined;
    if (!match && !q.from && !q.convId && !q.hasFile) return { messages: [], tookMs: 0 };
    const rows = this.messages.search({
      match,
      from: q.from,
      convId: q.convId,
      hasFile: q.hasFile,
      after: q.after,
      before: q.before,
      limit: q.limit ?? 50,
    });
    const hits = rows.map((r) => ({
      message: this.messageViews(r.convId, [r])[0]!,
      snippet: r.snippet,
    }));
    return { messages: hits, tookMs: performance.now() - started };
  }

  /** Rebuild every materialised table from the signed event log (plan section 8). */
  rebuild(): void {
    this.requireNetwork().sync.rebuild();
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
    if (this.statusTimer) this.clock.clearInterval(this.statusTimer);
    for (const t of this.receiptTimers.values()) this.clock.clearTimeout(t);
    this.transfers?.stop();
    try {
      await this.network?.stop();
    } catch (err) {
      this.logger.warn('network stop failed', { err: String(err) });
    }
    await this.files.close();
    this.listeners.clear();
    this.store.close();
    this.logger.info('core stopped');
  }
}

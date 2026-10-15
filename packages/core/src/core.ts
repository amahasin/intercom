import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import {
  encodeBase64Url,
  MAX_AVATAR_BYTES,
  MAX_RELAY_PARTICIPANTS,
  PROTOCOL_VERSION,
  RELAY_CAPABLE_SCORE,
  RELAY_CAPPED_PARTICIPANTS,
  type RelayMethod,
  type FileRef,
  type LinkPreview,
  type ManualPresenceState,
  type Member,
  type MsgRef,
  type ProfileEdit,
  type Recurrence,
  type CALL_REACTIONS,
} from '@officemesh/protocol';
import type {
  MeetingOccurrence,
  CallHistoryItem,
  CallSignal,
  CallView,
  ScreenSource,
  FileListItem,
  MemberView,
  PublicTeamView,
  TeamView,
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
  Diagnostics,
  UpdateStatus,
} from '@officemesh/protocol/ipc';
import { CallManager, type CallOutcome, type CallSession } from './calls/manager.ts';
import { FileStore, isUnhashed } from './files/store.ts';
import { CallChatRepo } from './store/callchats.ts';
import { isExecutable, safeFileName, uniqueName } from './files/names.ts';
import { nextOccurrence, occurrences, toIcs } from './meetings/occurrences.ts';
import { TransferManager } from './files/transfer.ts';
import { sha256 } from './identity/crypto.ts';
import {
  encodeBase32,
  MAX_GROUP_PICTURE_CHARS,
  type CallDeclineReason,
} from '@officemesh/protocol';
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
import { createConsoleLogger, systemClock, type LogFile } from './platform.ts';
import { applyStagedImport, exportProfile, stageProfileImport } from './identity/profile-move.ts';
import {
  compareVersions,
  isVersion,
  UpdateService,
  type SignatureCheck,
} from './updates/updates.ts';
import { collectDiagnostics } from './diagnostics.ts';
import { detectWiredLink, relayCapability, type RelayCapability } from './relay/capability.ts';
import { RelayHost, relayFrames } from './relay/host.ts';
import { availableParallelism, networkInterfaces } from 'node:os';
import { CallRepo } from './store/calls.ts';
import { ConversationRepo, type ConversationSummaryRow } from './store/conversations.ts';
import { MessageRepo, type MessageRow } from './store/messages.ts';
import { Store } from './store/store.ts';
import { HybridClock } from './sync/hlc.ts';
import { channelConvId, generalChannelId, newNonce } from './sync/ids.ts';
import { excerpt, mentionIds } from './sync/markdown.ts';
import type { Effects } from './sync/materialize.ts';

export const DATABASE_FILE_NAME = 'officemesh.db';

const PASTE_LIMIT_BYTES = 25 * 1024 * 1024;
/** A file message newer than this counts as arriving now. */
const AUTO_RECEIVE_WITHIN_MS = 10 * 60 * 1000;
/** Slack for clocks that disagree when judging whether a file was sent while this PC was away. */
const AWAY_SLACK_MS = 5 * 60 * 1000;
/** How often "this PC is running" is written down (what lets it tell, later, how long it was away). */
const RUNNING_MARK_MS = 30_000;
/** How often poll deadlines are looked at, and the latest a poll may close. */
const POLL_SWEEP_MS = 10_000;
const POLL_LONGEST_MS = 366 * 24 * 3_600_000;
/** How many wanted downloads a restart picks up again. */
const RESUME_DOWNLOADS = 200;
/** An identical reply from a notification within this long is the same reply, delivered twice. */
const TOAST_REPLY_DEDUPE_MS = 5_000;
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
  /** An incoming call: no reply box; clicking opens the window to answer. */
  call?: boolean;
}

/** What the host needs to know about a call to give it a window. */
export interface HostCall {
  callId: string;
  /** Ringing here (an incoming call window) rather than a call to show. */
  ringing: boolean;
  media: 'audio' | 'video';
  /** The caller (incoming) or the conversation or colleague (otherwise). */
  name: string;
}

/** Things only the host process (Electron main) can do. */
export interface HostServices {
  /** Add the Windows Firewall rules; prompts for elevation. Resolves when the attempt ends. */
  fixFirewall(): Promise<void>;
  openNetworkSettings(): void;
  notify?(toast: Toast): void;
  /** The calls this PC has changed: the host opens and closes the call windows to match. */
  calls?(calls: HostCall[]): void;
  /** Total unread, for the taskbar badge and tray tooltip. */
  setBadge?(count: number): void;
  openPath?(path: string): void;
  showInFolder?(path: string): void;
  snip?(): void;
  setStartWithWindows?(enabled: boolean): void;
  /** Light, dark or system: the host switches every window (and the title bar) to match. */
  setTheme?(theme: 'system' | 'light' | 'dark'): void;
  /** Screens and windows that can be shared, with thumbnails. */
  screenSources?(): Promise<ScreenSource[]>;
  /** Draw a coloured border around the screen being shared (null removes it). */
  screenBorder?(sourceId: string | null): void;
  /** Authenticode check of a file, or of this app when `path` is null (M6 updates). */
  verifySignature?(path: string | null): Promise<SignatureCheck>;
  /** Run an installer and close the app for it. */
  runInstaller?(path: string): void;
  /** Restart the app (after a profile import). */
  relaunch?(): void;
  /** Ask the user to pick a profile file to import. */
  pickProfileFile?(): Promise<string | null>;
  /** Ask the user for a folder (a folder dialog starting at `current`); null: cancelled. */
  pickFolder?(current: string): Promise<string | null>;
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
  /** Where exported files (.ics) go; default the user's Downloads folder. */
  downloadsDir?: string;
  /** Shared, content-addressed file store (default `<dataDir>/../files`). */
  filesDir?: string;
  /**
   * Where new installers are looked for when Settings names no folder (an office's own share).
   * An update found there has to be installed before the app can be used again.
   */
  updateFolder?: string;
  /**
   * The GitHub repository ("owner/name") whose releases are looked at for updates, when the user
   * allows it (Settings). Set by the installed app only.
   */
  updateRepo?: string;
  /** The project's GitHub repository ("owner/name"), shown in About (set in every build, unlike `updateRepo`). */
  repository?: string;
  clock?: Clock;
  logger?: Logger;
  /** Display name for a new identity; defaults to the Windows account's full name. */
  defaultDisplayName?: () => Promise<string>;
  /** Discovery and peer links. Without it the core runs offline (identity and store only). */
  network?: CoreNetworkOptions;
  host?: HostServices;
  /** The profile's log file, for diagnostics (absent in tests). */
  logFile?: LogFile;
  /** This build's CPU architecture (installer choice); defaults to the process's. */
  arch?: string;
  /** Host relay for large meetings (M6). */
  relay?: RelayOptions;
}

export interface RelayOptions {
  /** The mediasoup worker executable (absent: this build cannot host). */
  workerBin?: string | undefined;
  /** Addresses participants reach this PC on; default its LAN IPv4 addresses. */
  listenIps?: string[];
  /** Test builds: a fixed relay score instead of measuring the PC. */
  score?: number;
  /** Test builds: move calls to the relay above this many people. */
  meshLimit?: number;
  maxWorkers?: number;
  /** Load tests: let simulated participants use plain RTP transports. */
  allowPlain?: boolean;
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
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.tsv': 'text/tab-separated-values',
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
  /** The chats made for calls of three or more people (kept out of the list; see migration 13). */
  readonly callChats: CallChatRepo;
  /** While the organiser's PC makes a call chat, conversation events wait until it is marked. */
  private heldConversations: Set<string> | undefined;
  private makingCallChat = false;
  readonly hlc: HybridClock;
  network: PeerNetwork | undefined;
  /** The public teams last advertised in `hello` (JSON), to re-send only on change. */
  private advertised = '[]';
  transfers: TransferManager | undefined;
  calls: CallManager | undefined;
  readonly callHistory: CallRepo;
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
  private reminderTimer: TimerHandle | undefined;
  private pollTimer: TimerHandle | undefined;
  /** Poll deadlines up to this time have been dealt with (see `closeDuePolls`). */
  private pollsCheckedAt = 0;
  private runningTimer: TimerHandle | undefined;
  /** When this PC last ran before this start: a file sent since then was waiting for it. */
  private awaySince = 0;
  private lastToastReply:
    { convId: string; text: string; at: number; view: MessageView } | undefined;
  private closed = false;
  readonly updates: UpdateService;
  private relayCap: RelayCapability = { score: 0, capable: false, reason: 'Checking this PC…' };
  private wiredBps = 0;
  private relayCapTimer: TimerHandle | undefined;
  private relayStatsTimer: ReturnType<typeof setInterval> | undefined;

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
    this.callChats = new CallChatRepo(store.db);
    this.messages = new MessageRepo(store.db);
    this.files = new FileStore(options.filesDir ?? join(options.dataDir, '..', 'files'), store.db, {
      saveDir: () => this.saveFolder(),
    });
    this.hlc = new HybridClock(clock);
    this.callHistory = new CallRepo(store.db);
    this.updates = new UpdateService({
      clock,
      logger,
      appVersion: options.appVersion,
      arch: options.arch ?? process.arch,
      folder: () => this.updateFolder(),
      ...(options.updateRepo && {
        github: {
          repo: options.updateRepo,
          enabled: () => this.store.getSetting<boolean>('updates.github') ?? true,
        },
      }),
      host: {
        ...(options.host?.verifySignature && {
          verifySignature: (p) => options.host!.verifySignature!(p),
        }),
        ...(options.host?.runInstaller && {
          runInstaller: (p) => options.host!.runInstaller!(p),
        }),
      },
      changed: (s) => this.emit('updates.changed', s),
    });
  }

  static async start(options: CoreOptions): Promise<Core> {
    const clock = options.clock ?? systemClock;
    const logger = options.logger ?? createConsoleLogger(`core:${options.profile}`);
    // A profile imported from another PC replaces this one before anything opens it.
    if (
      applyStagedImport(
        options.dataDir,
        join(options.filesDir ?? join(options.dataDir, '..', 'files'), 'avatars'),
        clock.now(),
      )
    )
      logger.info('imported profile put in place');
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
      // Files sent while this PC was off (or its network was) are fetched when it is back.
      core.awaySince = store.getSetting<number>('app.lastRunAt') ?? clock.now();
      core.markRunning();
      core.runningTimer = clock.setInterval(() => core!.markRunning(), RUNNING_MARK_MS);
      if (options.network) await core.startNetwork(options.network);
      core.resumeDownloads();
      core.updates.start();
      core.refreshRelayCapability(true);
      core.relayCapTimer = clock.setInterval(() => core!.refreshRelayCapability(true), 10 * 60_000);
      core.statusTimer = clock.setInterval(() => core!.expireStatus(), 60_000);
      core.reminderTimer = clock.setInterval(() => core!.remindMeetings(), 30_000);
      // Polls that reached their deadline while this PC was off are dealt with now.
      core.pollsCheckedAt = core.awaySince - 60_000;
      core.pollTimer = clock.setInterval(() => core!.closeDuePolls(), POLL_SWEEP_MS);
      core.expireStatus();
      options.host?.setStartWithWindows?.(core.settings().startWithWindows);
      options.host?.setTheme?.(core.settings().theme);
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

  private markRunning(): void {
    this.store.setSetting('app.lastRunAt', this.clock.now());
  }

  /** Pick up the downloads that were waiting for a sender when the app last closed. */
  private resumeDownloads(): void {
    if (!this.transfers) return;
    for (const sha of this.files.wantedFiles(RESUME_DOWNLOADS)) {
      try {
        this.downloadFile(sha);
      } catch (err) {
        this.logger.warn('could not resume a download', { err: String(err) });
      }
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
        membershipChanged: (convIds) => this.onMembershipChanged(convIds),
        learnKey: (userId, spki) => {
          try {
            this.network?.directory.learn(userId, spki);
          } catch (err) {
            this.logger.warn('member key rejected', { userId, err: String(err) });
          }
        },
      },
      onPeerOnlineChanged: (peer) => this.onPeerOnlineChanged(peer),
      onStatusChanged: () => this.emitNetworkStatusIfChanged(),
      publicTeams: () => this.publicTeams(),
    });
    this.network = network;
    this.transfers = new TransferManager({
      store: this.files,
      links: network.links,
      clock: this.clock,
      logger: this.logger,
      selfId: this.userId,
      membersFor: (sha) => this.fileSources(sha).filter((u) => u !== this.userId),
      mayServe: (sha, userId) => this.fileMembers(sha).includes(userId),
      isOnline: (userId) => network.directory.get(userId)?.online === true,
      dial: (userId) => network.dial(userId),
      progress: (status) => this.emit('files.progress', status),
      uploads: (sha, uploads) => this.emit('files.upload', { sha256: sha, uploads }),
      completed: () => {},
    });
    this.calls = new CallManager({
      selfId: this.userId,
      privateKey: this.identity.privateKey,
      links: network.links,
      connect: (userId) => network.connect(userId),
      keyFor: (userId) => network.directory.get(userId)?.publicKey,
      doNotDisturb: () => this.presence.view().manual === 'dnd',
      mayJoin: (convId, userId) => this.conversations.isMember(convId, userId),
      relayScore: () => this.relayCap.score,
      ...(this.options.relay?.meshLimit !== undefined && {
        meshLimit: this.options.relay.meshLimit,
      }),
      startRelay: (call, epoch) => this.startRelay(call.callId, epoch),
      repo: this.callHistory,
      clock: this.clock,
      logger: this.logger,
      events: {
        changed: (call, endedCallId) => {
          this.presence.setInCall(this.calls?.inCall ?? false);
          if (call) this.maintainCallChat(call);
          this.emit('call.changed', {
            call: call ? this.callView(call) : null,
            ...(endedCallId && { callId: endedCallId }),
          });
          this.options.host?.calls?.(
            (this.calls?.calls ?? []).map((c) => ({
              callId: c.callId,
              ringing: c.state === 'ringing',
              media: c.media,
              name:
                c.state === 'ringing' || c.direction === 'in'
                  ? this.nameOf(c.caller)
                  : (c.convId && this.conversations.get(c.convId)?.title) ||
                    [...c.roster.keys(), ...c.invited]
                      .filter((u) => u !== this.userId)
                      .map((u) => this.nameOf(u))
                      .join(', '),
            })),
          );
        },
        ended: (call, outcome) => {
          this.endCallChat(call);
          this.onMeetingCallEnded(call);
          this.rememberEnded(call, outcome);
          this.emit('call.ended', {
            callId: call.callId,
            outcome,
            declines: [...call.declines].map(([userId, reason]) => ({ userId, reason })),
          });
        },
        reaction: (callId, from, emoji) => this.emit('call.reaction', { callId, from, emoji }),
        controlled: (callId, action) => this.emit('call.controlled', { callId, action }),
        relay: (callId, epoch, method, data) =>
          this.emit('call.relay', { callId, epoch, method, data }),
        signal: (callId, from, signal) => this.emit('call.signal', { callId, from, signal }),
        incoming: (call) => this.onIncomingCall(call),
        missed: (call, auto) => this.onMissedCall(call, auto),
        historyChanged: () =>
          this.emit('calls.history.changed', { items: this.callHistoryItems() }),
      },
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
    network.setManualAddresses(this.settings().peerAddresses);
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
      ...(this.options.repository && { repository: this.options.repository }),
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

  /** The update folder: the one chosen in Settings, else the office's own (blank means that one). */
  private updateFolder(): string {
    const chosen = (this.store.getSetting<string>('updates.folder') ?? '').trim();
    return chosen || this.options.updateFolder || '';
  }

  settings(): Settings {
    return {
      readReceipts: this.store.getSetting<boolean>('privacy.readReceipts') ?? true,
      startWithWindows: this.store.getSetting<boolean>('app.startWithWindows') ?? true,
      audioInput: this.store.getSetting<string>('calls.audioInput') ?? '',
      audioOutput: this.store.getSetting<string>('calls.audioOutput') ?? '',
      videoInput: this.store.getSetting<string>('calls.videoInput') ?? '',
      peerAddresses: this.store.getSetting<string[]>('network.peerAddresses') ?? [],
      updateFolder: this.updateFolder(),
      githubUpdates: this.store.getSetting<boolean>('updates.github') ?? true,
      relayHosting: this.store.getSetting<'auto' | 'never'>('calls.relayHosting') ?? 'auto',
      saveFolder: this.saveFolder(),
      theme: this.store.getSetting<'system' | 'light' | 'dark'>('app.theme') ?? 'system',
      look: this.store.getSetting<'classic' | 'harbor' | 'paper'>('app.look') ?? 'paper',
      accent: this.store.getSetting<string>('app.accent') ?? '',
      autoReceive: this.store.getSetting<boolean>('files.autoReceive') ?? true,
      noiseSuppression:
        this.store.getSetting<'off' | 'standard' | 'high'>('calls.noiseSuppression') ?? 'high',
    };
  }

  setSettings(change: Partial<Settings>): Settings {
    if (change.readReceipts !== undefined)
      this.store.setSetting('privacy.readReceipts', change.readReceipts);
    if (change.startWithWindows !== undefined) {
      this.store.setSetting('app.startWithWindows', change.startWithWindows);
      this.options.host?.setStartWithWindows?.(change.startWithWindows);
    }
    for (const key of ['audioInput', 'audioOutput', 'videoInput'] as const) {
      if (change[key] !== undefined) this.store.setSetting(`calls.${key}`, change[key]);
    }
    if (change.peerAddresses !== undefined) {
      const valid = [...new Set(change.peerAddresses.map((a) => a.trim()))].filter(
        (a) => PeerNetwork.parseAddress(a) !== undefined,
      );
      this.store.setSetting('network.peerAddresses', valid);
      this.network?.setManualAddresses(valid);
    }
    if (change.githubUpdates !== undefined) {
      this.store.setSetting('updates.github', change.githubUpdates);
      void this.updates.check();
    }
    if (change.updateFolder !== undefined) {
      this.store.setSetting('updates.folder', change.updateFolder.trim());
      void this.updates.check();
    }
    if (change.saveFolder !== undefined) {
      const wanted = change.saveFolder.trim();
      if (wanted) {
        if (!isAbsolute(wanted)) throw new NotAvailableError('Choose a full folder path.');
        // The folder must be a real, writable place: say so now, not when a file arrives.
        try {
          mkdirSync(wanted, { recursive: true });
          const probe = join(wanted, `.officemesh-write-test-${process.pid}`);
          writeFileSync(probe, '');
          rmSync(probe, { force: true });
        } catch {
          throw new NotAvailableError('InterCom cannot save files to that folder.');
        }
        this.store.setSetting('files.saveFolder', resolve(wanted));
      } else this.store.setSetting('files.saveFolder', '');
    }
    if (change.autoReceive !== undefined)
      this.store.setSetting('files.autoReceive', change.autoReceive);
    if (change.noiseSuppression !== undefined)
      this.store.setSetting('calls.noiseSuppression', change.noiseSuppression);
    if (change.theme !== undefined) {
      this.store.setSetting('app.theme', change.theme);
      this.options.host?.setTheme?.(change.theme);
    }
    if (change.look !== undefined) this.store.setSetting('app.look', change.look);
    if (change.accent !== undefined) this.store.setSetting('app.accent', change.accent);
    if (change.relayHosting !== undefined) {
      this.store.setSetting('calls.relayHosting', change.relayHosting);
      this.refreshRelayCapability();
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

  /** Take colleagues off the people list. Someone who is online cannot be removed. */
  hidePeople(userIds: string[], hidden: boolean): PersonView[] {
    const network = this.requireNetwork();
    const out: PersonView[] = [];
    for (const userId of userIds) {
      const peer = network.directory.get(userId);
      if (!peer || (hidden && peer.online)) continue;
      const changed = network.directory.setHidden(userId, hidden);
      if (changed) out.push(network.directory.view(changed));
    }
    return out;
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
    const members = this.conversations.members(row.convId);
    const meta = JSON.parse(row.metaJson) as {
      private?: boolean;
      archived?: boolean;
      picture?: string;
    };
    let title = row.title ?? '';
    if (row.kind === 'direct') title = peer?.profile?.displayName ?? 'Unknown colleague';
    else if (row.kind === 'group' && !title) {
      const names = members.filter((m) => m !== this.userId).map((m) => this.nameOf(m));
      title =
        names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '') ||
        'Group chat';
    }
    const temporary = this.callChats.isHidden(row.convId);
    return {
      convId: row.convId,
      kind: row.kind,
      ...(row.peerUserId && { peerUserId: row.peerUserId }),
      title,
      ...(temporary && { temporary: true }),
      ...(row.kind === 'group' && meta.picture && { picture: meta.picture }),
      memberCount: members.length,
      active: members.includes(this.userId),
      ...(row.teamId && { teamId: row.teamId }),
      ...(meta.private !== undefined && { private: meta.private }),
      ...(meta.archived !== undefined && { archived: meta.archived }),
      ...(row.lastAuthor !== null &&
        row.lastText !== null &&
        row.lastAt !== null && {
          lastMessage: { author: row.lastAuthor, text: row.lastText.slice(0, 200), at: row.lastAt },
        }),
      lastActivityAt: row.lastActivity,
      unread: temporary ? 0 : this.messages.unread(row.convId, this.userId),
      notify:
        this.messages.notifyLevel(row.convId) ?? (row.kind === 'channel' ? 'mentions' : 'all'),
    };
  }

  conversationList(): ConversationView[] {
    return this.conversations.list().map((r) => this.conversationView(r));
  }

  private emitConversations(convIds: string[]): void {
    if (this.heldConversations) {
      for (const id of convIds) this.heldConversations.add(id);
      return;
    }
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
        thread?: MsgRef;
        announcement?: { headline: string };
        options?: string[];
        multi?: boolean;
        maxChoices?: number;
        anonymous?: boolean;
        results?: 'always' | 'voted' | 'closed';
        closesAt?: number;
        start?: number;
        end?: number;
        recurrence?: Recurrence;
        notes?: string;
        callId?: string;
        media?: 'audio' | 'video';
        meeting?: MsgRef;
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
        kind: row.kind === 'file' ? 'file' : 'text',
        kindDetail:
          row.kind === 'file' ||
          row.kind === 'poll' ||
          row.kind === 'meeting' ||
          row.kind === 'call'
            ? row.kind
            : 'post',
        ...(row.kind === 'meeting' &&
          !row.deleted && { meeting: this.meetingInfo(convId, row, body) }),
        ...(row.kind === 'call' &&
          body.callId && {
            callCard: {
              callId: body.callId,
              media: body.media ?? 'video',
              ended: this.messages.callEnded(convId, row),
              ...(body.meeting && { meeting: body.meeting }),
            },
          }),
        ...(body.thread && { thread: body.thread }),
        ...this.threadInfo(convId, row),
        ...(body.announcement && !row.deleted && { announcement: body.announcement }),
        ...(row.kind === 'poll' &&
          !row.deleted && {
            poll: this.pollView(convId, row, body),
          }),
        text: row.deleted ? '' : row.text,
        mine,
        ...(mine &&
          this.network && {
            status: this.network.sync.status(convId, row.seq, { t: row.hlcT, c: row.hlcC }),
          }),
        mentions: body.mentions ?? [],
        mentionsMe: row.mentionsMe === 1 && !row.deleted,
        // What a message was sent with goes when the message does.
        urgent: row.urgent === 1 && !row.deleted,
        edited: row.editedT !== null,
        deleted: row.deleted === 1,
        pinned: pinned.has(key),
        saved: this.messages.isSaved(convId, row),
        ...(replyTo && !row.deleted && { replyTo }),
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

  private threadInfo(
    convId: string,
    row: MessageRow,
  ): { replyCount: number; lastReplyAt?: number } {
    if (row.threadAuthor !== null) return { replyCount: 0 };
    const kind = this.conversations.get(convId)?.kind;
    if (kind !== 'channel') return { replyCount: 0 };
    const stats = this.messages.replyStats(convId, row);
    return { replyCount: stats.count, ...(stats.last !== null && { lastReplyAt: stats.last }) };
  }

  /**
   * A poll as this user sees it. It is closed by its author's close or at its deadline, whichever
   * is first; votes cast from then on do not count. One vote per person (the latest), at most
   * `maxChoices` choices of it. Counts are left out while the poll keeps them hidden from this
   * user (until they vote, or until it closes; its author always sees them), and names are left
   * out of a poll that hides them.
   */
  private pollView(
    convId: string,
    row: MessageRow,
    body: {
      options?: string[];
      multi?: boolean;
      maxChoices?: number;
      anonymous?: boolean;
      results?: 'always' | 'voted' | 'closed';
      closesAt?: number;
    },
  ): NonNullable<MessageView['poll']> {
    const options = body.options ?? [];
    const multi = body.multi === true;
    const max = multi ? Math.min(body.maxChoices ?? options.length, options.length) : 1;
    const close = this.messages.pollClose(convId, row);
    const deadline = body.closesAt;
    let closedAt = close?.t;
    if (deadline !== undefined && this.clock.now() >= deadline)
      closedAt = closedAt === undefined ? deadline : Math.min(closedAt, deadline);
    // Votes cast after the poll closed, or from its deadline on, do not count.
    const votes = this.messages
      .votes(convId, row)
      .filter(
        (v) =>
          (!close || v.t < close.t || (v.t === close.t && v.c < close.c)) &&
          (deadline === undefined || v.t < deadline),
      );
    const chosenBy = options.map((): string[] => []);
    let mine: number[] = [];
    let voters = 0;
    for (const v of votes) {
      const choices = [...new Set(v.choices)].filter((c) => c < options.length).slice(0, max);
      if (choices.length === 0) continue;
      voters++;
      for (const c of choices) chosenBy[c]!.push(v.voter);
      if (v.voter === this.userId) mine = choices;
    }
    const results = body.results ?? 'always';
    const closed = closedAt !== undefined;
    const shown =
      closed ||
      results === 'always' ||
      row.author === this.userId ||
      (results === 'voted' && mine.length > 0);
    const hidden = shown ? undefined : results === 'voted' ? 'voted' : 'closed';
    return {
      question: row.text,
      multi,
      closed,
      voters,
      options: options.map((text, i) => ({
        text,
        votes: hidden ? 0 : chosenBy[i]!.length,
        mine: mine.includes(i),
        ...(!hidden && !body.anonymous && { voters: chosenBy[i]! }),
      })),
      ...(multi && max < options.length && { maxChoices: max }),
      ...(body.anonymous && { anonymous: true }),
      ...(body.results && body.results !== 'always' && { results: body.results }),
      ...(hidden && { hidden }),
      ...(deadline !== undefined && { closesAt: deadline }),
      ...(closedAt !== undefined && { closedAt }),
    };
  }

  /**
   * Polls whose deadline has just passed: show them closed, and from the author's PC also send
   * the close, so PCs on a version that does not know deadlines stop counting too.
   */
  private closeDuePolls(): void {
    const now = this.clock.now();
    const due = this.messages.pollsDue(this.pollsCheckedAt, now);
    this.pollsCheckedAt = now;
    const byConv = new Map<string, MsgRef[]>();
    for (const p of due) {
      const target = { author: p.author, seq: p.seq };
      if (p.author === this.userId && !this.messages.pollClose(p.convId, target) && this.network) {
        try {
          this.requireActive(p.convId);
          this.network.sync.append(p.convId, 'poll.close', { target });
        } catch (err) {
          this.logger.debug('poll close at its deadline not sent', { err: String(err) });
        }
      }
      byConv.set(p.convId, [...(byConv.get(p.convId) ?? []), target]);
    }
    for (const [convId, refs] of byConv) this.emitMessages('messages.updated', convId, refs);
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
    rootsOnly = false,
  ): MessageView[] {
    if (!this.conversations.get(convId)) throw new NotAvailableError('unknown conversation');
    const rows = rootsOnly
      ? this.messages.roots(convId, limit, before)
      : this.messages.list(convId, limit, before);
    return this.messageViews(convId, rows);
  }

  /** A channel post and its replies. */
  threadMessages(convId: string, root: MsgRef): MessageView[] {
    const head = this.messages.get(convId, root);
    if (!head) throw new NotAvailableError('unknown message');
    return this.messageViews(convId, [head, ...this.messages.thread(convId, root)]);
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
      thread?: MsgRef | undefined;
      announcement?: { headline: string } | undefined;
    } = {},
  ): MessageView {
    if (!text.trim()) throw new NotAvailableError('message is empty');
    this.requireActive(convId);
    if (extra.thread && !this.messages.get(convId, extra.thread))
      throw new NotAvailableError('unknown thread');
    const mentions = extra.mentions ?? mentionIds(text);
    const ref = this.requireNetwork().sync.append(convId, 'msg.post', {
      text,
      ...(mentions.length > 0 && { mentions }),
      ...(extra.replyTo && { replyTo: extra.replyTo }),
      ...(extra.urgent && { urgent: true }),
      ...(extra.preview && { preview: extra.preview }),
      ...(extra.thread && { thread: extra.thread }),
      ...(extra.announcement && !extra.thread && { announcement: extra.announcement }),
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
      // Read receipts: direct chats and groups of up to 20 (plan section 10), never channels.
      const small = conv.kind === 'group' && this.conversations.members(convId).length <= 20;
      if (this.settings().readReceipts && (conv.kind === 'direct' || small))
        this.scheduleReceipt(convId);
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
      // A new reply changes its thread root's reply count.
      for (const ref of added) {
        const row = this.messages.get(convId, ref);
        if (row?.threadAuthor === null || row?.threadAuthor === undefined) continue;
        const root = { author: row.threadAuthor, seq: row.threadSeq! };
        if (!updated.some((r) => r.author === root.author && r.seq === root.seq))
          updated.push(root);
      }
      this.emitMessages('messages.added', convId, added);
      this.emitMessages('messages.updated', convId, updated);
      for (const ref of added) this.noteFile(convId, ref);
      this.noteCallChat(convId, added);
      let meetings = false;
      for (const ref of refs) {
        const row = this.messages.get(convId, ref);
        if (row?.kind === 'meeting') meetings = true;
        if (row?.kind === 'call') {
          meetings = true;
          this.mergeMeetingCall(convId, row);
        }
      }
      if (meetings) this.emit('meetings.changed', {});
    }
    if (fx.activity.length > 0) this.emitActivity();
    for (const { convId, row } of fx.incoming) this.considerToast(convId, row);
    if (!local) this.updateBadge();
  }

  /**
   * Remember shared files. A file that arrives is saved to the chosen folder at once (the
   * "Receive files automatically" setting, on by default): this is a LAN messenger, and sending
   * a file is meant to deliver it. That includes a file sent while this PC was off or away: it
   * is fetched as soon as the message reaches it, and as soon as the sender can be reached. With
   * the setting off, nothing is downloaded until the user asks (a picture shows its small preview
   * and a click saves it). Files from before this PC took part are never fetched by themselves.
   */
  private noteFile(convId: string, ref: MsgRef): void {
    const row = this.messages.get(convId, ref);
    if (!row || row.kind !== 'file') return;
    const file = (JSON.parse(row.bodyJson) as { file?: FileRef }).file;
    if (!file) return;
    this.files.note(file, convId, this.clock.now());
    // Arriving now, or sent while this PC was away (and only now reaching it): history from
    // before this PC took part is not fetched.
    const arriving =
      this.clock.now() - row.hlcT < AUTO_RECEIVE_WITHIN_MS ||
      row.hlcT >= this.awaySince - AWAY_SLACK_MS;
    if (row.author !== this.userId && arriving && this.settings().autoReceive) {
      try {
        this.downloadFile(file.sha256);
      } catch (err) {
        this.logger.warn('automatic receive failed', { err: String(err) });
      }
    }
  }

  private considerToast(convId: string, row: MessageRow): void {
    // The chat of a call is in the call window: no banner, no unread count, until it is kept.
    if (this.callChats.isHidden(convId)) return;
    // The card of a call this PC is ringing for or in already has its own banner.
    if (row.kind === 'call') {
      const callId = (JSON.parse(row.bodyJson) as { callId?: string }).callId;
      if (callId && this.calls?.calls.some((c) => c.callId === callId)) return;
    }
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
    const thread = (JSON.parse(row.bodyJson) as { thread?: MsgRef }).thread;
    const personal =
      row.mentionsMe === 1 ||
      body.replyTo?.author === this.userId ||
      thread?.author === this.userId;
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
      .filter(
        (c) =>
          this.messages.notifyLevel(c.convId) !== 'muted' && !this.callChats.isHidden(c.convId),
      )
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
    // Windows can deliver one typed reply more than once (the notification's reply event fires
    // for each toast still open for the chat). The same words to the same chat within seconds are
    // one reply: say it once.
    const now = this.clock.now();
    const last = this.lastToastReply;
    if (
      last &&
      last.convId === convId &&
      last.text === text &&
      now - last.at < TOAST_REPLY_DEDUPE_MS
    )
      return last.view;
    const view = this.sendMessage(convId, text);
    this.lastToastReply = { convId, text, at: now, view };
    return view;
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
      if (a.kind === 'missed-call') {
        return {
          id: a.id,
          kind: a.kind,
          convId: a.convId,
          author: a.author,
          excerpt: a.emoji === 'video' ? 'Missed video call' : 'Missed call',
          at: a.at,
          read: a.read === 1,
        };
      }
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
  // Calls
  // -------------------------------------------------------------------------

  private requireCalls(): CallManager {
    if (!this.calls) throw new NotAvailableError('networking is not running');
    return this.calls;
  }

  /** Run a call command, reporting its failures as "not available" to the UI. */
  private callCommand<T>(run: (calls: CallManager) => T): T {
    try {
      return run(this.requireCalls());
    } catch (err) {
      if (err instanceof NotAvailableError) throw err;
      throw new NotAvailableError(err instanceof Error ? err.message : String(err));
    }
  }

  callView(call: CallSession): CallView {
    const participants = [...call.roster.values()]
      .filter((p) => !p.left)
      .map((p) => {
        const peer = this.network?.directory.get(p.userId);
        const avatarHash =
          p.userId === this.userId ? this.identity.profile.avatarHash : peer?.profile?.avatarHash;
        return { ...p, name: this.nameOf(p.userId), ...(avatarHash && { avatarHash }) };
      });
    return {
      callId: call.callId,
      ...(call.convId && { convId: call.convId }),
      ...(call.chat && { chat: call.chat }),
      media: call.media,
      direction: call.direction,
      state: call.state,
      ...(this.calls?.isWaiting(call) && { waiting: true }),
      ...(this.calls?.isHeld(call) && { held: true }),
      caller: call.caller,
      organizer: call.organizer,
      invited: [...call.invited],
      participants,
      declines: [...call.declines].map(([userId, reason]) => ({ userId, reason })),
      startedAt: call.startedAt,
      ...(call.answeredAt !== undefined && { answeredAt: call.answeredAt }),
      ...(call.relay && {
        relay: {
          host: call.relay.host,
          epoch: call.relay.epoch,
          max: call.relay.max,
          reconnecting: call.relay.reconnecting,
        },
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Host relay (M6)
  // -------------------------------------------------------------------------

  /** Re-measure whether this PC can host (wired link, cores, setting); `probe` asks Windows. */
  refreshRelayCapability(probe = false): void {
    const forced = this.options.relay?.score;
    const apply = () => {
      this.relayCap =
        forced !== undefined
          ? {
              score: forced,
              capable: forced >= RELAY_CAPABLE_SCORE,
              reason: 'Set for testing.',
            }
          : relayCapability({
              workerBin: this.options.relay?.workerBin,
              wiredBps: this.wiredBps,
              hosting: this.settings().relayHosting,
            });
    };
    apply();
    if (probe && forced === undefined && this.options.relay?.workerBin)
      void detectWiredLink().then((w) => {
        this.wiredBps = w.wiredBps;
        apply();
      });
  }

  private relayListenIps(): string[] {
    const fixed = this.options.relay?.listenIps;
    if (fixed?.length) return fixed;
    const ips: string[] = [];
    for (const list of Object.values(networkInterfaces()))
      for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    return ips.length ? ips : ['127.0.0.1'];
  }

  /** Start hosting the media relay for the current call. */
  private async startRelay(callId: string, epoch: number): Promise<RelayHost> {
    const RELAY_NOTIFY_GATHER_MS = 50;
    const calls = this.requireCalls();
    const network = this.requireNetwork();
    const outbox = new Map<string, Array<{ method: string; data: unknown }>>();
    const host = new RelayHost({
      callId,
      epoch,
      listenIps: this.relayListenIps(),
      maxWorkers: this.options.relay?.maxWorkers ?? Math.min(16, availableParallelism()),
      maxParticipants:
        this.relayCap.score >= RELAY_CAPABLE_SCORE
          ? MAX_RELAY_PARTICIPANTS
          : RELAY_CAPPED_PARTICIPANTS,
      workerBin: this.options.relay?.workerBin,
      allowPlain: this.options.relay?.allowPlain === true,
      logger: this.logger,
      mayJoin: (userId) => calls.mayJoinRelay(userId),
      notify: (userId, method, data) => {
        const body = { callId, epoch, method, data };
        if (userId === this.userId) {
          queueMicrotask(() => calls.deliverRelayNotify(this.userId, body));
          return;
        }
        // Everything for one participant in this turn travels as one frame.
        let queue = outbox.get(userId);
        if (!queue) {
          outbox.set(userId, (queue = []));
          // Gathered for 50 ms: at most 20 frames a second per person, well inside the
          // link's 50-frame limit however busy the meeting gets.
          setTimeout(() => {
            outbox.delete(userId);
            for (const frame of relayFrames(queue!))
              network.links.send(userId, 'relay.notify', { callId, epoch, ...frame });
          }, RELAY_NOTIFY_GATHER_MS);
        }
        queue.push({ method, data });
      },
    });
    await host.start();
    this.logger.info('hosting the meeting relay', { callId, epoch });
    if (this.relayStatsTimer) clearInterval(this.relayStatsTimer);
    this.relayStatsTimer = setInterval(() => {
      if (calls.relayHost !== host) {
        if (this.relayStatsTimer) clearInterval(this.relayStatsTimer);
        this.relayStatsTimer = undefined;
        return;
      }
      const s = host.stats();
      this.emit('call.relayStats', {
        callId,
        cpuPercent: s.cpuPercent,
        sendMbps: s.sendMbps,
        recvMbps: s.recvMbps,
        participants: s.participants,
        workers: s.workers,
      });
    }, 2_000);
    return host;
  }

  /** A media request from the renderer to the call's relay host. */
  relayRequest(
    callId: string,
    epoch: number,
    method: RelayMethod,
    data: unknown,
  ): Promise<unknown> {
    return this.requireCalls()
      .relayRequest(callId, epoch, method, data)
      .catch((err: unknown) => {
        throw new NotAvailableError(err instanceof Error ? err.message : String(err));
      });
  }

  currentCall(): CallView | null {
    const call = this.calls?.call;
    return call ? this.callView(call) : null;
  }

  callHistoryItems(): CallHistoryItem[] {
    return this.callHistory.list();
  }

  startCall(input: {
    convId?: string | undefined;
    userIds: string[];
    media: 'audio' | 'video';
  }): CallView {
    if (input.convId && !this.conversations.get(input.convId)) {
      throw new NotAvailableError('unknown conversation');
    }
    // A call of two always has its chat: the direct chat with the other person.
    let convId = input.convId;
    const others = [...new Set(input.userIds)].filter((u) => u !== this.userId);
    if (!convId && others.length === 1) {
      try {
        convId = this.openDirect(others[0]!).convId;
      } catch {
        // not a known person yet: the call goes ahead without a chat
      }
    }
    const call = this.callCommand((c) => c.start({ ...input, ...(convId && { convId }) }));
    this.announceGroupCall(call);
    return this.callView(call);
  }

  /**
   * A call made from a group chat leaves a card there, like "Meet now" does, so a member who
   * missed the ring (or turned it down) can still join from the chat while the call goes on.
   */
  private announceGroupCall(call: CallSession): void {
    if (!call.convId || call.open) return;
    try {
      const conv = this.conversations.get(call.convId);
      if (conv?.kind !== 'group' || this.callChats.isHidden(call.convId)) return;
      this.requireActive(call.convId);
      this.requireNetwork().sync.append(call.convId, 'call.started', {
        callId: call.callId,
        media: call.media,
      });
      call.announced = true;
    } catch (err) {
      this.logger.warn('could not leave a card for the group call', { err: String(err) });
    }
  }

  acceptCall(callId: string, video: boolean, how?: 'hold' | 'end'): CallView {
    return this.callView(this.callCommand((c) => c.accept(callId, video, how)));
  }

  mergeCall(callId: string): CallView {
    return this.callView(this.callCommand((c) => c.merge(callId)));
  }

  resumeCall(callId: string): CallView {
    return this.callView(this.callCommand((c) => c.resume(callId)));
  }

  /** Calls that ended in the last minute, for a window that opened too late to hear. */
  private readonly recentlyEnded = new Map<
    string,
    {
      at: number;
      outcome: CallOutcome;
      declines: Array<{ userId: string; reason: CallDeclineReason }>;
      call: CallView;
    }
  >();

  private rememberEnded(call: CallSession, outcome: CallOutcome): void {
    const now = this.clock.now();
    for (const [id, e] of this.recentlyEnded)
      if (now - e.at > 60_000) this.recentlyEnded.delete(id);
    this.recentlyEnded.set(call.callId, {
      at: now,
      outcome,
      declines: [...call.declines].map(([userId, reason]) => ({ userId, reason })),
      call: this.callView(call),
    });
  }

  endedCall(callId: string): {
    outcome: CallOutcome;
    declines: Array<{ userId: string; reason: CallDeclineReason }>;
    call: CallView;
  } | null {
    const e = this.recentlyEnded.get(callId);
    return e ? { outcome: e.outcome, declines: e.declines, call: e.call } : null;
  }

  callList(): CallView[] {
    return (this.calls?.calls ?? []).map((c) => this.callView(c));
  }

  declineCall(callId: string): void {
    this.callCommand((c) => c.decline(callId));
  }

  hangupCall(callId: string): void {
    this.callCommand((c) => c.hangup(callId));
  }

  /** Organiser only: end the call for everyone (anyone else uses `hangupCall` to leave). */
  endCallForAll(callId: string): void {
    this.callCommand((c) => c.endForAll(callId));
  }

  // -------------------------------------------------------------------------
  // The chat of a call that grew past two people
  // -------------------------------------------------------------------------

  /**
   * Keep the call's chat in step with the call. Everyone hides the chat once they hear of it.
   * The organiser's PC makes it when the third person is in (a call from a group has that group's
   * chat already), and adds whoever joins later. The chat is an ordinary group: nothing here is a
   * second chat implementation, only a different life (see `endCallChat`).
   */
  private maintainCallChat(call: CallSession): void {
    if (call.chat) this.callChats.add(call.chat, call.callId, this.clock.now());
    if (!this.calls || call.state !== 'active' || call.relay || call.open) return;
    if (call.organizer !== this.userId) return;
    const here = this.calls.members(call);
    if (!call.chat) {
      if (here.length < 3) return;
      const conv = call.convId ? this.conversations.get(call.convId) : undefined;
      if (conv && conv.kind !== 'direct') return;
      this.createCallChat(call, here);
      return;
    }
    const have = new Set(this.conversations.members(call.chat));
    const missing = here.filter((u) => !have.has(u));
    if (missing.length === 0) return;
    try {
      this.addMembers(call.chat, missing);
    } catch (err) {
      this.logger.warn('could not add someone to the call chat', { err: String(err) });
    }
  }

  private createCallChat(call: CallSession, here: string[]): void {
    if (this.makingCallChat || !this.network) return;
    this.makingCallChat = true;
    this.heldConversations = new Set();
    let held = new Set<string>();
    try {
      const view = this.createGroup(here.filter((u) => u !== this.userId));
      held = this.heldConversations;
      this.heldConversations = undefined;
      // Marked before anyone sees it in a list.
      this.callChats.add(view.convId, call.callId, this.clock.now());
      this.calls?.setChat(call.callId, view.convId);
      held.add(view.convId);
    } catch (err) {
      this.logger.warn('could not make the call chat', { err: String(err) });
    } finally {
      held = this.heldConversations ?? held;
      this.heldConversations = undefined;
      this.makingCallChat = false;
    }
    if (held.size > 0) this.emitConversations([...held]);
  }

  /** Someone wrote in a call's chat: it is worth keeping (and a discarded one comes back). */
  private noteCallChat(convId: string, added: MsgRef[]): void {
    const chat = this.callChats.get(convId);
    if (!chat) return;
    const real = added.some((ref) => {
      const row = this.messages.get(convId, ref);
      return row !== undefined && row.kind !== 'call' && row.kind !== 'meeting';
    });
    if (!real) return;
    if (!chat.interacted) this.callChats.markInteracted(convId);
    if (chat.state === 'discarded') {
      this.callChats.setState(convId, 'kept');
      this.emitConversations([convId]);
    }
  }

  /**
   * This PC's call is over: a chat somebody wrote in joins the chat list, with all it holds; one
   * nobody used is never shown (its creation stays in the log as an invisible record, since
   * signed events cannot be taken back).
   */
  private endCallChat(call: CallSession): void {
    const ids = new Set(this.callChats.byCall(call.callId).map((c) => c.convId));
    if (call.chat) ids.add(call.chat);
    const changed: string[] = [];
    for (const convId of ids) {
      const chat = this.callChats.get(convId);
      if (!chat || chat.state !== 'active') continue;
      this.callChats.setState(convId, chat.interacted ? 'kept' : 'discarded');
      changed.push(convId);
    }
    if (changed.length > 0) this.emitConversations(changed);
  }

  inviteToCall(callId: string, userIds: string[]): CallView {
    return this.callView(this.callCommand((c) => c.invite(callId, userIds)));
  }

  updateCall(
    callId: string,
    change: {
      muted?: boolean;
      video?: boolean;
      sharing?: boolean;
      onHold?: boolean;
      spoke?: boolean;
      hand?: boolean;
      recording?: boolean;
    },
  ): void {
    this.callCommand((c) => c.update(callId, change));
  }

  callSignal(callId: string, to: string, signal: CallSignal): void {
    this.callCommand((c) => c.signal(callId, to, signal));
  }

  callDropped(callId: string, userId: string): void {
    this.callCommand((c) => c.dropped(callId, userId));
  }

  async screenSources(): Promise<ScreenSource[]> {
    const host = this.options.host;
    if (!host?.screenSources) throw new NotAvailableError('screen sharing needs the desktop app');
    return host.screenSources();
  }

  screenBorder(sourceId: string | null): void {
    this.options.host?.screenBorder?.(sourceId);
  }

  /** The chat a call belongs to, for Activity and toasts (a 1:1 chat with the caller if none). */
  private callConv(call: CallSession): string | undefined {
    if (call.convId && this.conversations.get(call.convId)) return call.convId;
    try {
      return this.network?.sync.openDirect(call.caller).convId;
    } catch {
      return undefined;
    }
  }

  /**
   * An incoming call gets no system notification: the app's own small call window (always on
   * top, in the corner) is the only thing that rings. A call nobody answered still leaves a
   * "Missed call" toast and Activity entry (see `onMissedCall`).
   */
  private onIncomingCall(_call: CallSession): void {}

  /** Nobody answered (or Do not disturb or another call declined it): Activity and a toast. */
  private onMissedCall(call: CallSession, auto: 'dnd' | 'busy' | null): void {
    const convId = this.callConv(call);
    if (!convId) return;
    const id = this.messages.addActivity({
      kind: 'missed-call',
      convId,
      author: call.caller,
      targetAuthor: call.caller,
      targetSeq: 0,
      sourceSeq: call.startedAt,
      emoji: call.media,
      at: call.startedAt,
    });
    if (id !== undefined) this.emitActivity();
    // Do not disturb means no toast, here as for messages.
    if (auto === 'dnd') return;
    this.options.host?.notify?.({
      id: `call-${call.callId}`,
      convId,
      target: { author: call.caller, seq: 1 },
      title: 'Missed call',
      body: `${this.nameOf(call.caller)} tried to call you`,
      urgent: false,
    });
  }

  // -------------------------------------------------------------------------
  // Meetings
  // -------------------------------------------------------------------------

  private meetingInfo(
    convId: string,
    row: MessageRow,
    body: { start?: number; end?: number; recurrence?: Recurrence; notes?: string },
  ): NonNullable<MessageView['meeting']> {
    const cancels = this.messages.cancellations(convId, row);
    const rsvps = this.messages.rsvps(convId, row) as Array<{
      userId: string;
      response: 'accepted' | 'tentative' | 'declined';
    }>;
    const mine = rsvps.find((r) => r.userId === this.userId)?.response;
    return {
      title: row.text,
      start: body.start ?? 0,
      end: body.end ?? 0,
      recurrence: body.recurrence ?? { freq: 'none' },
      ...(body.notes && { notes: body.notes }),
      cancelled: cancels.includes(0),
      cancelledOccurrences: cancels.filter((c) => c !== 0),
      rsvps,
      ...(mine && { myResponse: mine }),
    };
  }

  /**
   * Schedule a meeting: in a chat or channel the user belongs to, or (with invitees) in a
   * new meeting chat. Invitees who are offline get it when they next sync, like a message.
   */
  scheduleMeeting(input: {
    title: string;
    start: number;
    end: number;
    recurrence: Recurrence;
    notes?: string | undefined;
    convId?: string | undefined;
    invitees?: string[] | undefined;
  }): { convId: string; target: MsgRef } {
    if (input.end <= input.start) throw new NotAvailableError('a meeting must end after it starts');
    if (input.end - input.start > 24 * 60 * 60 * 1000) {
      throw new NotAvailableError('a meeting can last at most a day');
    }
    let convId = input.convId;
    if (!convId) {
      const invitees = (input.invitees ?? []).filter((u) => u !== this.userId);
      if (invitees.length === 0) throw new NotAvailableError('invite at least one person');
      convId = this.createGroup(invitees, input.title.slice(0, 100)).convId;
    }
    this.requireActive(convId);
    const target = this.requireNetwork().sync.append(convId, 'meeting.schedule', {
      title: input.title,
      start: input.start,
      end: input.end,
      recurrence: input.recurrence,
      ...(input.notes && { notes: input.notes }),
    });
    return { convId, target };
  }

  private requireMeeting(convId: string, target: MsgRef): MessageRow {
    const row = this.messages.get(convId, target);
    if (row?.kind !== 'meeting' || row.deleted) throw new NotAvailableError('unknown meeting');
    return row;
  }

  updateMeeting(input: {
    convId: string;
    target: MsgRef;
    title: string;
    start: number;
    end: number;
    recurrence: Recurrence;
    notes?: string | undefined;
  }): void {
    const row = this.requireMeeting(input.convId, input.target);
    if (row.author !== this.userId) throw new NotAvailableError('only the organiser can change it');
    const { convId, target, ...fields } = input;
    this.requireNetwork().sync.append(convId, 'meeting.update', {
      target,
      ...fields,
      ...(fields.notes === undefined && { notes: undefined }),
    });
  }

  cancelMeeting(convId: string, target: MsgRef, occurrence?: number): void {
    const row = this.requireMeeting(convId, target);
    if (row.author !== this.userId) throw new NotAvailableError('only the organiser can cancel it');
    this.requireNetwork().sync.append(convId, 'meeting.cancel', {
      target,
      ...(occurrence !== undefined && { occurrence }),
    });
  }

  rsvpMeeting(
    convId: string,
    target: MsgRef,
    response: 'accepted' | 'tentative' | 'declined',
  ): void {
    this.requireMeeting(convId, target);
    this.requireActive(convId);
    this.requireNetwork().sync.append(convId, 'meeting.rsvp', { target, response });
  }

  /** Occurrences of every meeting this user is invited to that overlap [from, to). */
  meetingOccurrences(from: number, to: number): MeetingOccurrence[] {
    const titles = new Map(this.conversationList().map((c) => [c.convId, c.title]));
    const out: MeetingOccurrence[] = [];
    for (const row of this.messages.ofKind('meeting', this.userId)) {
      const body = JSON.parse(row.bodyJson) as {
        start: number;
        end: number;
        recurrence: Recurrence;
        notes?: string;
      };
      const info = this.meetingInfo(row.convId, row, body);
      const live = this.liveCall(row.convId) !== undefined;
      for (const start of occurrences(body, from, to)) {
        out.push({
          convId: row.convId,
          conversation: titles.get(row.convId) ?? '',
          target: { author: row.author, seq: row.seq },
          organizer: row.author,
          title: row.text,
          start,
          end: start + (body.end - body.start),
          recurrence: info.recurrence,
          ...(info.notes && { notes: info.notes }),
          cancelled: info.cancelled || info.cancelledOccurrences.includes(start),
          attendees: this.conversations.members(row.convId),
          rsvps: info.rsvps,
          ...(info.myResponse && { myResponse: info.myResponse }),
          live,
        });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Toast 15 minutes before each meeting this user has not declined (plan section 9). */
  remindMeetings(): void {
    const now = this.clock.now();
    const done = new Set(this.store.getSetting<string[]>('meetings.reminded') ?? []);
    let changed = false;
    for (const row of this.messages.ofKind('meeting', this.userId)) {
      const body = JSON.parse(row.bodyJson) as {
        start: number;
        end: number;
        recurrence: Recurrence;
      };
      const info = this.meetingInfo(row.convId, row, body);
      if (info.cancelled || info.myResponse === 'declined') continue;
      const next = nextOccurrence(body, now, 15 * 60_000);
      if (next === undefined || info.cancelledOccurrences.includes(next)) continue;
      const key = `${row.convId}:${row.author}:${row.seq}:${next}`;
      if (done.has(key)) continue;
      done.add(key);
      changed = true;
      const minutes = Math.max(1, Math.round((next - now) / 60_000));
      this.options.host?.notify?.({
        id: `meeting-${key}`,
        convId: row.convId,
        target: { author: row.author, seq: row.seq },
        title: `${row.text} in ${minutes} minute${minutes === 1 ? '' : 's'}`,
        body: 'Open the meeting chat to join.',
        urgent: false,
      });
    }
    if (changed) this.store.setSetting('meetings.reminded', [...done].slice(-500));
  }

  /** Write the meeting as an .ics file to the Downloads folder and show it in Explorer. */
  exportMeetingIcs(convId: string, target: MsgRef): { path: string } {
    const row = this.requireMeeting(convId, target);
    const body = JSON.parse(row.bodyJson) as {
      start: number;
      end: number;
      recurrence: Recurrence;
      notes?: string;
    };
    const info = this.meetingInfo(convId, row, body);
    const ics = toIcs({
      uid: `${row.author}-${row.seq}-${convId}@officemesh.lan`,
      title: row.text,
      start: body.start,
      end: body.end,
      recurrence: body.recurrence,
      notes: body.notes,
      organizer: this.nameOf(row.author),
      attendees: this.conversations.members(convId).map((u) => this.nameOf(u)),
      exceptions: info.cancelledOccurrences,
      cancelled: info.cancelled,
      stamp: this.clock.now(),
    });
    const dir = this.options.downloadsDir ?? join(homedir(), 'Downloads');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${safeFileName(row.text) || 'meeting'}.ics`);
    writeFileSync(path, ics, 'utf8');
    this.options.host?.showInFolder?.(path);
    return { path };
  }

  private readonly recordings = new Map<
    string,
    { path: string; name: string; mime: string; finalPath: string }
  >();

  /** Start receiving a local recording; pieces are appended to a file in the profile. */
  beginRecording(name: string, mime: 'video/mp4' | 'video/webm'): { id: string } {
    const id = randomBytes(16).toString('hex');
    // A recording is the recorder's own file: it is made in their save folder and shared
    // from there, not copied into the app's data.
    const dir = join(this.saveFolder(), 'Meeting recordings');
    mkdirSync(dir, { recursive: true });
    const ext = mime === 'video/mp4' ? '.mp4' : '.webm';
    const base = safeFileName(name).replace(/\.(mp4|webm)$/i, '') || 'Meeting recording';
    const finalName = uniqueName(dir, `${base}${ext}`, existsSync);
    const path = join(dir, `${finalName}.recording`);
    writeFileSync(path, new Uint8Array(0));
    this.recordings.set(id, { path, name: finalName, mime, finalPath: join(dir, finalName) });
    return { id };
  }

  appendRecording(id: string, data: Uint8Array): void {
    const rec = this.recordings.get(id);
    if (!rec) throw new NotAvailableError('unknown recording');
    appendFileSync(rec.path, data);
  }

  /** Share the finished recording to the meeting chat (plan section 9). */
  async finishRecording(id: string, convId: string): Promise<MessageView> {
    const rec = this.recordings.get(id);
    if (!rec) throw new NotAvailableError('unknown recording');
    this.recordings.delete(id);
    try {
      renameSync(rec.path, rec.finalPath);
    } catch (err) {
      rmSync(rec.path, { force: true });
      throw new NotAvailableError(
        `The recording could not be saved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.shareFile({ convId, path: rec.finalPath, name: rec.name, mime: rec.mime });
  }

  abortRecording(id: string): void {
    const rec = this.recordings.get(id);
    this.recordings.delete(id);
    if (rec) rmSync(rec.path, { force: true });
  }

  /** The newest call announced in a conversation that is not over, if it started today. */
  private liveCall(convId: string): MessageRow | undefined {
    const row = this.messages.latestCall(convId);
    if (!row || this.messages.callEnded(convId, row)) return undefined;
    if (this.clock.now() - row.hlcT > 12 * 60 * 60 * 1000) return undefined;
    return row;
  }

  /**
   * Meet now in a chat or channel (plan section 9): join the meeting already running
   * there, or start one and post a card others can join from. A scheduled meeting's call
   * has an id derived from the meeting and the day, so two people starting it at once end
   * up in the same call.
   */
  async meetNow(convId: string, media: 'audio' | 'video', meeting?: MsgRef): Promise<CallView> {
    this.requireActive(convId);
    const live = this.liveCall(convId);
    if (live) {
      try {
        return await this.joinCall(convId, { author: live.author, seq: live.seq });
      } catch {
        // Nobody answered: that meeting is over, start a fresh one.
      }
    }
    const day = new Date(this.clock.now()).toDateString();
    const callId = meeting
      ? encodeBase32(
          sha256(
            `officemesh/meeting-call/v1\0${convId}\0${meeting.author}:${meeting.seq}\0${day}`,
          ).subarray(0, 20),
        )
      : undefined;
    const call = this.callCommand((c) =>
      c.start({ convId, userIds: [], media, open: true, ...(callId && { callId }) }),
    );
    this.requireNetwork().sync.append(convId, 'call.started', {
      callId: call.callId,
      media,
      ...(meeting && { meeting }),
    });
    return this.callView(call);
  }

  /** Join the meeting a "call started" card announces, through whoever in it is online. */
  async joinCall(convId: string, target: MsgRef): Promise<CallView> {
    this.requireActive(convId);
    const row = this.messages.get(convId, target);
    const body = row
      ? (JSON.parse(row.bodyJson) as { callId?: string; media?: 'audio' | 'video' })
      : {};
    if (row?.kind !== 'call' || !body.callId) throw new NotAvailableError('unknown meeting');
    if (this.messages.callEnded(convId, row)) throw new NotAvailableError('this meeting has ended');
    const network = this.requireNetwork();
    const online = this.conversations
      .members(convId)
      .filter((u) => u !== this.userId && network.directory.get(u)?.online)
      .sort((a, b) => (a === row.author ? -1 : b === row.author ? 1 : 0))
      .slice(0, 20);
    try {
      const call = await this.requireCalls().join(
        body.callId,
        convId,
        online,
        body.media === 'video',
      );
      return this.callView(call);
    } catch (err) {
      throw new NotAvailableError(err instanceof Error ? err.message : String(err));
    }
  }

  reactInCall(callId: string, emoji: (typeof CALL_REACTIONS)[number]): void {
    this.callCommand((c) => c.react(callId, emoji));
  }

  controlCall(
    callId: string,
    action: 'mute' | 'remove' | 'spotlight',
    target: string | null,
  ): void {
    this.callCommand((c) => c.control(callId, action, target));
  }

  /** The last person to leave a meeting marks its card as over. */
  private onMeetingCallEnded(call: CallSession): void {
    if (!(call.open || call.announced) || !call.convId) return;
    const others = [...call.roster.values()].filter((p) => !p.left && p.userId !== this.userId);
    if (others.length > 0) return;
    const card = this.messages.latestCall(call.convId);
    if (!card || (JSON.parse(card.bodyJson) as { callId?: string }).callId !== call.callId) return;
    try {
      this.network?.sync.append(call.convId, 'call.ended', {
        target: { author: card.author, seq: card.seq },
      });
    } catch (err) {
      this.logger.warn('could not mark the meeting over', { err: String(err) });
    }
  }

  /** Someone else started the meeting we are in (same call id): ask them to let us in. */
  private mergeMeetingCall(convId: string, row: MessageRow): void {
    const call = this.calls?.call;
    if (!call || call.convId !== convId || row.author === this.userId) return;
    const body = JSON.parse(row.bodyJson) as { callId?: string };
    if (body.callId !== call.callId || call.roster.has(row.author)) return;
    this.calls?.requestMerge(row.author);
  }

  // -------------------------------------------------------------------------
  // Groups, teams, channels, polls
  // -------------------------------------------------------------------------

  private requireActive(convId: string): void {
    const conv = this.conversations.get(convId);
    if (!conv) throw new NotAvailableError('unknown conversation');
    if (conv.kind !== 'direct' && !this.conversations.isMember(convId, this.userId)) {
      throw new NotAvailableError('you are no longer a member of this conversation');
    }
    const meta = JSON.parse(conv.metaJson) as { archived?: boolean };
    if (meta.archived) throw new NotAvailableError('this channel is archived');
  }

  /** A member entry for a person whose key this PC knows (for membership events). */
  private memberEntry(userId: string, role?: 'owner' | 'member'): Member {
    if (userId === this.userId) {
      return {
        userId,
        spki: encodeBase64Url(this.identity.spki),
        name: this.identity.profile.displayName,
        ...(role && { role }),
      };
    }
    const peer = this.network?.directory.get(userId);
    if (!peer) throw new NotAvailableError('unknown person');
    return {
      userId,
      spki: encodeBase64Url(peer.spki),
      name: (peer.profile?.displayName ?? 'Colleague').slice(0, 64),
      ...(role && { role }),
    };
  }

  private onMembershipChanged(convIds: string[]): void {
    for (const convId of convIds) this.emit('conversation.reset', { convId });
    this.emitConversations(convIds);
    if (convIds.some((id) => this.conversations.get(id)?.kind !== 'group')) {
      this.emit('teams.changed', { teams: this.teams() });
      const advertised = JSON.stringify(this.publicTeams());
      if (advertised !== this.advertised) {
        this.advertised = advertised;
        this.network?.links.refreshHello();
      }
    }
  }

  createGroup(memberIds: string[], title?: string): ConversationView {
    const sync = this.requireNetwork().sync;
    const ids = [...new Set([this.userId, ...memberIds])];
    if (ids.length < 2) throw new NotAvailableError('a group needs at least one other person');
    const members = ids.map((u) => this.memberEntry(u));
    const convId = sync.create('group.create', {
      members,
      nonce: newNonce(),
      ...(title && { title }),
    });
    return this.conversationView(this.conversations.list().find((r) => r.convId === convId)!);
  }

  conversationMembers(convId: string): MemberView[] {
    const tl = this.network?.sync.memberships.timeline(convId);
    return this.conversations.memberRoles(convId).map(({ userId, role }) => {
      const peer = this.network?.directory.get(userId);
      return {
        userId,
        name:
          userId === this.userId
            ? this.identity.profile.displayName
            : (peer?.profile?.displayName ?? tl?.keys.get(userId)?.name ?? 'Colleague'),
        role,
        online: userId === this.userId || peer?.online === true,
        ...(peer?.profile?.avatarHash && { avatarHash: peer.profile.avatarHash }),
      };
    });
  }

  /** The log a membership change goes into: the conversation's own, or a channel's team. */
  private controlLog(convId: string): { logId: string; channelId?: string } {
    const conv = this.conversations.get(convId);
    if (!conv) throw new NotAvailableError('unknown conversation');
    if (conv.kind === 'channel') return { logId: conv.teamId!, channelId: convId };
    if (conv.kind === 'direct')
      throw new NotAvailableError('direct chats have exactly two people; start a group instead');
    return { logId: convId };
  }

  addMembers(convId: string, userIds: string[]): MemberView[] {
    const { logId, channelId } = this.controlLog(convId);
    this.requireActive(logId);
    const members = userIds.map((u) => this.memberEntry(u));
    this.requireNetwork().sync.append(logId, 'member.add', {
      members,
      ...(channelId && { channelId }),
    });
    return this.conversationMembers(convId);
  }

  removeMember(convId: string, userId: string): MemberView[] {
    const { logId, channelId } = this.controlLog(convId);
    this.requireActive(logId);
    this.requireNetwork().sync.append(logId, 'member.remove', {
      userId,
      ...(channelId && { channelId }),
    });
    return this.conversationMembers(convId);
  }

  /** Delete a chat's history from this PC. The others keep theirs. */
  deleteChat(convId: string): void {
    const kind = this.conversations.get(convId)?.kind;
    if (kind !== 'direct' && kind !== 'group')
      throw new NotAvailableError('only chats and group chats can be deleted');
    this.messages.deleteHistory(convId);
    this.emit('conversation.reset', { convId });
    this.emitConversations([convId]);
    this.emitActivity();
  }

  leave(convId: string): void {
    const { logId, channelId } = this.controlLog(convId);
    this.requireNetwork().sync.append(logId, 'member.leave', { ...(channelId && { channelId }) });
  }

  renameConversation(convId: string, title: string): ConversationView {
    const conv = this.conversations.get(convId);
    if (conv?.kind !== 'group')
      throw new NotAvailableError('only group chats are renamed this way');
    this.requireActive(convId);
    this.requireNetwork().sync.append(convId, 'conv.rename', { title });
    return this.conversationView(this.conversations.list().find((r) => r.convId === convId)!);
  }

  /** Any member can give a group a picture (a small JPEG, base64), or take it away (empty). */
  setGroupPicture(convId: string, picture: string): ConversationView {
    const conv = this.conversations.get(convId);
    if (conv?.kind !== 'group') throw new NotAvailableError('only group chats have a picture');
    if (picture.length > MAX_GROUP_PICTURE_CHARS)
      throw new NotAvailableError('that picture is too big');
    this.requireActive(convId);
    this.requireNetwork().sync.append(convId, 'conv.rename', { picture });
    return this.conversationView(this.conversations.list().find((r) => r.convId === convId)!);
  }

  teams(): TeamView[] {
    const sync = this.network?.sync;
    if (!sync) return [];
    const all = this.conversations.list();
    return this.conversations.byKind('team').flatMap((row) => {
      const tl = sync.memberships.timeline(row.convId);
      if (!tl?.valid) return [];
      const role = tl.scope.current.get(this.userId);
      const channels = all
        .filter((c) => c.teamId === row.convId)
        .map((c) => this.conversationView(c))
        .filter((c) => c.active || role === 'owner')
        .sort((a, b) =>
          a.title === 'General' ? -1 : b.title === 'General' ? 1 : a.title.localeCompare(b.title),
        );
      return [
        {
          teamId: row.convId,
          name: tl.title ?? 'Team',
          ...(tl.description && { description: tl.description }),
          visibility: tl.visibility ?? 'private',
          ...(role && { role }),
          memberCount: tl.scope.current.size,
          channels,
        },
      ];
    });
  }

  private team(teamId: string): TeamView {
    const team = this.teams().find((t) => t.teamId === teamId);
    if (!team) throw new NotAvailableError('unknown team');
    return team;
  }

  createTeam(input: {
    name: string;
    description?: string | undefined;
    visibility: 'public' | 'private';
    members: string[];
  }): TeamView {
    const sync = this.requireNetwork().sync;
    const nonce = newNonce();
    const ids = [...new Set([this.userId, ...input.members])];
    const teamId = sync.create('team.create', {
      name: input.name,
      ...(input.description && { description: input.description }),
      visibility: input.visibility,
      members: ids.map((u) => this.memberEntry(u, u === this.userId ? 'owner' : 'member')),
      general: generalChannelId(this.userId, nonce),
      nonce,
    });
    return this.team(teamId);
  }

  renameTeam(teamId: string, name: string, description?: string): TeamView {
    this.requireActive(teamId);
    this.requireNetwork().sync.append(teamId, 'team.rename', {
      name,
      ...(description !== undefined && { description }),
    });
    return this.team(teamId);
  }

  setTeamRole(teamId: string, userId: string, role: 'owner' | 'member'): MemberView[] {
    this.requireActive(teamId);
    this.requireNetwork().sync.append(teamId, 'member.role', { userId, role });
    return this.conversationMembers(teamId);
  }

  createChannel(input: {
    teamId: string;
    name: string;
    description?: string | undefined;
    private: boolean;
    members?: string[] | undefined;
  }): ConversationView {
    this.requireActive(input.teamId);
    const nonce = newNonce();
    const channelId = channelConvId(input.teamId, this.userId, nonce);
    this.requireNetwork().sync.append(input.teamId, 'channel.create', {
      channelId,
      name: input.name,
      ...(input.description && { description: input.description }),
      private: input.private,
      ...(input.private && input.members && { members: input.members }),
      nonce,
    });
    const row = this.conversations.list().find((r) => r.convId === channelId);
    if (!row) throw new NotAvailableError('only team owners can create channels');
    return this.conversationView(row);
  }

  private channelChange(
    teamId: string,
    channelId: string,
    type: 'channel.rename' | 'channel.archive',
    body: Record<string, unknown>,
  ): ConversationView {
    this.requireActive(teamId);
    this.requireNetwork().sync.append(teamId, type, { channelId, ...body });
    const row = this.conversations.list().find((r) => r.convId === channelId);
    if (!row) throw new NotAvailableError('unknown channel');
    return this.conversationView(row);
  }

  renameChannel(teamId: string, channelId: string, name: string): ConversationView {
    return this.channelChange(teamId, channelId, 'channel.rename', { name });
  }

  archiveChannel(teamId: string, channelId: string, archived: boolean): ConversationView {
    return this.channelChange(teamId, channelId, 'channel.archive', { archived });
  }

  /** Public teams this PC belongs to, advertised in `hello`. */
  publicTeams(): Array<{ teamId: string; name: string }> {
    return this.teams()
      .filter((t) => t.visibility === 'public' && t.role)
      .slice(0, 50)
      .map((t) => ({ teamId: t.teamId, name: t.name.slice(0, 100) }));
  }

  /** Public teams colleagues belong to and this user does not. */
  async discoverTeams(): Promise<PublicTeamView[]> {
    const network = this.requireNetwork();
    // Open links to a few online colleagues to hear what they advertise.
    const online = network.directory
      .all()
      .filter((p) => p.online && p.address && p.port)
      .slice(0, 30);
    await Promise.all(
      online.map((p) => network.links.ensureLink(p.userId, p.address!, p.port!).catch(() => false)),
    );
    const mine = new Set(
      this.teams()
        .filter((t) => t.role)
        .map((t) => t.teamId),
    );
    const found = new Map<string, PublicTeamView>();
    for (const userId of network.links.readyPeers()) {
      for (const t of network.links.publicTeamsOf(userId)) {
        if (mine.has(t.teamId)) continue;
        const entry = found.get(t.teamId) ?? { teamId: t.teamId, name: t.name, via: [] };
        entry.via.push(userId);
        found.set(t.teamId, entry);
      }
    }
    return [...found.values()];
  }

  async joinTeam(teamId: string): Promise<TeamView> {
    const network = this.requireNetwork();
    const via = (await this.discoverTeams()).find((t) => t.teamId === teamId)?.via ?? [];
    let lastError: unknown = new NotAvailableError('nobody who belongs to that team is online');
    for (const userId of via) {
      try {
        await network.sync.joinTeam(teamId, userId, this.memberEntry(this.userId));
        return this.team(teamId);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? new NotAvailableError(lastError.message) : lastError;
  }

  createPoll(
    convId: string,
    input: {
      question: string;
      options: string[];
      multi?: boolean | undefined;
      thread?: MsgRef | undefined;
      maxChoices?: number | undefined;
      anonymous?: boolean | undefined;
      results?: 'always' | 'voted' | 'closed' | undefined;
      closesAt?: number | undefined;
    },
  ): MessageView {
    this.requireActive(convId);
    const options = input.options.map((o) => o.trim());
    if (new Set(options.map((o) => o.toLocaleLowerCase())).size !== options.length)
      throw new NotAvailableError('Two options are the same.');
    const now = this.clock.now();
    if (
      input.closesAt !== undefined &&
      (input.closesAt < now + 60_000 || input.closesAt > now + POLL_LONGEST_MS)
    )
      throw new NotAvailableError('Choose a closing time between a minute and a year from now.');
    const max =
      input.multi && input.maxChoices !== undefined && input.maxChoices < options.length
        ? input.maxChoices
        : undefined;
    const ref = this.requireNetwork().sync.append(convId, 'poll.create', {
      question: input.question,
      options,
      ...(input.multi && { multi: true }),
      ...(input.thread && { thread: input.thread }),
      ...(max !== undefined && { maxChoices: max }),
      ...(input.anonymous && { anonymous: true }),
      ...(input.results && input.results !== 'always' && { results: input.results }),
      ...(input.closesAt !== undefined && { closesAt: input.closesAt }),
    });
    return this.view(convId, ref);
  }

  vote(convId: string, target: MsgRef, choices: number[]): MessageView {
    const poll = this.messages.get(convId, target);
    if (poll?.kind !== 'poll') throw new NotAvailableError('unknown poll');
    // A vote racing a close is dropped everywhere (it is later than the close); refuse it here.
    if (this.messages.pollClose(convId, target)) throw new NotAvailableError('this poll is closed');
    const body = JSON.parse(poll.bodyJson) as {
      options?: string[];
      multi?: boolean;
      maxChoices?: number;
      closesAt?: number;
    };
    if (body.closesAt !== undefined && this.clock.now() >= body.closesAt)
      throw new NotAvailableError('this poll is closed');
    const unique = [...new Set(choices)];
    if (unique.some((c) => c >= (body.options?.length ?? 0)))
      throw new NotAvailableError('unknown option');
    const max = body.multi ? (body.maxChoices ?? body.options?.length ?? 0) : 1;
    if (unique.length > max)
      throw new NotAvailableError(max === 1 ? 'choose one option' : `choose up to ${max} options`);
    choices = unique;
    this.requireActive(convId);
    this.requireNetwork().sync.append(convId, 'poll.vote', { target, choices });
    return this.view(convId, target);
  }

  closePoll(convId: string, target: MsgRef): MessageView {
    const poll = this.messages.get(convId, target);
    if (poll?.kind !== 'poll' || poll.author !== this.userId)
      throw new NotAvailableError('only the poll author can close it');
    this.requireNetwork().sync.append(convId, 'poll.close', { target });
    return this.view(convId, target);
  }

  /** Files shared in one conversation, or everywhere (Files tab and Files rail). */
  fileList(convId?: string): FileListItem[] {
    const titles = new Map(this.conversationList().map((c) => [c.convId, c.title]));
    return this.messages.files(convId).flatMap((row) => {
      const file = (JSON.parse(row.bodyJson) as { file?: FileRef }).file;
      if (!file) return [];
      return [
        {
          sha256: file.sha256,
          name: file.name,
          size: file.size,
          mime: file.mime,
          convId: row.convId,
          conversation: titles.get(row.convId) ?? '',
          author: row.author,
          at: row.hlcT,
          message: { author: row.author, seq: row.seq },
          state: this.fileStatus(file.sha256).state,
        },
      ];
    });
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  /** Everyone in a conversation where the file was shared may fetch it from this PC. */
  /**
   * Who a file may be fetched from. A file shared as it is has no chunk list to check what comes
   * back against, so it is fetched from the people who shared it, never from a third PC.
   */
  private fileSources(sha: string): string[] {
    const row = this.files.row(sha);
    if (!row || !isUnhashed(row)) return this.fileMembers(sha);
    return this.store.db
      .prepare(
        `SELECT DISTINCT author FROM messages
          WHERE kind = 'file' AND deleted = 0 AND json_extract(body_json, '$.file.sha256') = ?`,
      )
      .pluck()
      .all(sha) as string[];
  }

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
    prepareId?: string | undefined;
    thread?: MsgRef | undefined;
  }): Promise<MessageView> {
    const sync = this.requireNetwork().sync;
    if (!this.conversations.get(input.convId)) throw new NotAvailableError('unknown conversation');
    if (input.thread && !this.messages.get(input.convId, input.thread))
      throw new NotAvailableError('unknown thread');
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
      // As it is, at once: nothing is read, so the file is on its way as soon as the message is.
      ref = await this.files.importLive(input.path, name, mime, input.convId, now);
      if (input.prepareId)
        this.emit('files.preparing', {
          prepareId: input.prepareId,
          done: ref.size,
          total: ref.size,
        });
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
      ...(input.thread && { thread: input.thread }),
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
    let path: string;
    try {
      path = this.files.openablePath(sha);
    } catch (err) {
      throw new NotAvailableError(err instanceof Error ? err.message : String(err));
    }
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
      ...(this.network && { remoteOnline: this.network.remotePeersStatus().remoteOnline }),
      ...this.newerVersion(),
    };
  }

  /** "A colleague is running a newer version", from the versions linked peers report. */
  private newerVersion(): { newerVersion?: string } {
    const own = this.options.appVersion;
    if (!this.network || !isVersion(own)) return {};
    let best: string | undefined;
    for (const userId of this.network.links.readyPeers()) {
      const app = this.network.links.peerApp(userId) ?? '';
      if (!isVersion(app) || compareVersions(app, own) <= 0) continue;
      if (!best || compareVersions(app, best) > 0) best = app;
    }
    return best ? { newerVersion: best } : {};
  }

  // -------------------------------------------------------------------------
  // Other subnets, moving PCs, diagnostics, updates (M6)
  // -------------------------------------------------------------------------

  /** Link to a colleague on another subnet by address, and remember the address. */
  async addPeer(address: string): Promise<{ userId: string | null; name?: string }> {
    const network = this.requireNetwork();
    const text = address.trim();
    if (!PeerNetwork.parseAddress(text))
      throw new NotAvailableError('Type an IPv4 address, such as 10.1.2.3 or 10.1.2.3:47801.');
    const list = this.settings().peerAddresses;
    if (!list.includes(text)) this.setSettings({ peerAddresses: [...list, text] });
    const userId = (await network.dialManual(text)) ?? null;
    this.emitNetworkStatusIfChanged();
    if (!userId) return { userId: null };
    const name = network.directory.get(userId)?.profile?.displayName;
    return { userId, ...(name && { name }) };
  }

  /** Where received files are saved: the user's choice, else Downloads\InterCom. */
  saveFolder(): string {
    const chosen = this.store.getSetting<string>('files.saveFolder');
    return chosen || join(this.downloadsDir(), 'InterCom');
  }

  async pickSaveFolder(): Promise<{ path: string | null }> {
    return { path: (await this.options.host?.pickFolder?.(this.saveFolder())) ?? null };
  }

  showSaveFolder(): void {
    const folder = this.saveFolder();
    mkdirSync(folder, { recursive: true });
    this.options.host?.openPath?.(folder);
  }

  /**
   * The file behind `/files/<sha>` for the page (inline pictures and videos): only a
   * complete file whose recorded type is the type asked for.
   */
  servePath(sha: string, type: string): string | null {
    const row = this.files.row(sha);
    if (!row || row.state !== 'complete' || row.mime !== type) return null;
    return this.files.presence(row) === 'gone' ? null : this.files.path(sha);
  }

  private downloadsDir(): string {
    return this.options.downloadsDir ?? join(homedir(), 'Downloads');
  }

  /** Seal this profile into a file in Downloads for moving to another PC. */
  async exportProfile(passphrase: string): Promise<{ path: string }> {
    const dir = this.downloadsDir();
    mkdirSync(dir, { recursive: true });
    const day = new Date(this.clock.now()).toISOString().slice(0, 10);
    const name = safeFileName(
      `InterCom profile - ${this.identity.profile.displayName} - ${day}.omprofile`,
    );
    const path = join(dir, name);
    const hash = this.identity.profile.avatarHash;
    const avatarDir = join(this.files.dir, 'avatars');
    const avatar = hash
      ? ['png', 'jpg', 'webp']
          .map((e) => join(avatarDir, `${hash}.${e}`))
          .find((p) => existsSync(p))
      : undefined;
    await exportProfile({
      identity: this.identity,
      db: this.store.db,
      appVersion: this.options.appVersion,
      avatarPath: avatar,
      passphrase,
      outPath: path,
      now: this.clock.now(),
    });
    this.logger.info('profile exported');
    this.options.host?.showInFolder?.(path);
    return { path };
  }

  async pickProfileFile(): Promise<{ path: string | null }> {
    return { path: (await this.options.host?.pickProfileFile?.()) ?? null };
  }

  /** Check and stage a profile file; it takes over at the next start. */
  async importProfile(path: string, passphrase: string) {
    if (!existsSync(path)) throw new NotAvailableError('That file was not found.');
    try {
      const who = await stageProfileImport({
        path,
        passphrase,
        dataDir: this.options.dataDir,
        protector: this.options.keyProtector,
      });
      this.logger.info('profile import staged', { userId: who.userId });
      return who;
    } catch (err) {
      throw new NotAvailableError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Whether this PC can host large meetings' media relay, and whether it is hosting. */
  relayStatus(): Diagnostics['relay'] {
    const host = this.calls?.relayHost;
    return {
      capable: this.relayCap.capable,
      score: this.relayCap.score,
      reason: this.relayCap.reason,
      hosting: host !== undefined,
      participants: host?.stats().participants ?? 0,
    };
  }

  restart(): void {
    if (!this.options.host?.relaunch) throw new NotAvailableError('not available in this host');
    this.options.host.relaunch();
  }

  diagnostics(): Diagnostics {
    return collectDiagnostics(this, this.options.logFile?.tail(300) ?? []);
  }

  /** Write diagnostics and recent log lines to a text file in Downloads, and show it. */
  exportDiagnostics(): { path: string } {
    const d = this.diagnostics();
    const dir = this.downloadsDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date(d.generatedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = join(dir, `InterCom diagnostics ${stamp}.txt`);
    const { log, ...rest } = d;
    const fullLog = this.options.logFile?.tail(5_000) ?? log;
    writeFileSync(
      path,
      [
        'InterCom diagnostics',
        '======================',
        'Contains no message text. Share it with whoever supports the app in your office.',
        '',
        JSON.stringify(rest, null, 2),
        '',
        'Recent log',
        '----------',
        ...fullLog,
        '',
      ].join('\r\n'),
    );
    this.options.host?.showInFolder?.(path);
    return { path };
  }

  updateStatus(): UpdateStatus {
    return this.updates.current();
  }

  checkForUpdate(manual = false): Promise<UpdateStatus> {
    return this.updates.check(manual);
  }

  async installUpdate(): Promise<void> {
    try {
      await this.updates.install();
    } catch (err) {
      throw new NotAvailableError(err instanceof Error ? err.message : String(err));
    }
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
    if (this.reminderTimer) this.clock.clearInterval(this.reminderTimer);
    if (this.pollTimer) this.clock.clearInterval(this.pollTimer);
    if (this.runningTimer) this.clock.clearInterval(this.runningTimer);
    // A clean stop is the most exact "last ran" there is.
    this.markRunning();
    this.updates.stop();
    if (this.relayCapTimer) this.clock.clearInterval(this.relayCapTimer);
    if (this.relayStatsTimer) clearInterval(this.relayStatsTimer);
    for (const t of this.receiptTimers.values()) this.clock.clearTimeout(t);
    this.calls?.stop();
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

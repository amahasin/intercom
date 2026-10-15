/**
 * The one typed API between the renderer and the core: commands in, events out.
 * The renderer never talks to the core any other way (plan section 4, rule 1).
 *
 * Frames travel over a MessagePort that the main process hands to both ends. The core
 * validates every command's input; the client validates every result and event.
 */
import { z } from 'zod';
import { EpochMs, ProfileName, PublicKeyB64, Sha256Hex, UserId } from './common.ts';
import {
  ConversationKind,
  ConvId,
  FileRef,
  Hlc,
  LinkPreview,
  MAX_MESSAGE_TEXT,
  MsgRef,
  Recurrence,
} from './events.ts';
import { ManualPresenceState, PresenceState } from './presence.ts';
import { ProfileEdit } from './profile.ts';
import {
  AssistKind,
  AssistSessionId,
  MachineInfo,
  CALL_REACTIONS,
  CallDeclineReason,
  CallId,
  CallMedia,
  CallParticipant,
  IceCandidate,
  RELAY_NOTIFY_DATA,
  type RelayMethod,
  RelayRef,
  type RelayNotifyMethod,
} from './wire.ts';

// ---------------------------------------------------------------------------
// Views returned to the UI
// ---------------------------------------------------------------------------

export const IdentityView = z.object({
  userId: UserId,
  publicKey: PublicKeyB64,
  displayName: z.string(),
  jobTitle: z.string().optional(),
  statusMessage: z.string().optional(),
  statusExpiresAt: EpochMs.optional(),
  avatarHash: Sha256Hex.optional(),
  email: z.string().optional(),
  notes: z.string().optional(),
  /** office or home: where they are working today (unset: not said). */
  workplace: z.enum(['office', 'home']).optional(),
  profileVersion: z.number().int(),
  safetyPhrase: z.array(z.string()).length(6),
  createdAt: EpochMs,
});
export type IdentityView = z.infer<typeof IdentityView>;

export const AppInfo = z.object({
  appVersion: z.string(),
  protocolVersion: z.number().int(),
  profile: ProfileName,
  dataDir: z.string(),
  keyProtection: z.enum(['safeStorage', 'insecure-test']),
  /** Where the app's source and releases are (GitHub owner/name), for the About page. */
  repository: z.string().optional(),
  /** This PC as colleagues see it (name, system, hardware, Remote Desktop use). */
  machine: MachineInfo.optional(),
  /** This PC's network addresses (IPv4), as colleagues reach it. */
  addresses: z.array(z.string().max(64)).max(16).optional(),
});
export type AppInfo = z.infer<typeof AppInfo>;

export const PresenceView = z.object({
  /** What the user picked. */
  manual: ManualPresenceState,
  /** What colleagues see: manual, or Away while idle or locked. */
  effective: PresenceState,
  /** In a call: colleagues see "In a call" (and Busy, on builds that do not know it). */
  inCall: z.boolean().optional(),
  idle: z.boolean(),
  locked: z.boolean(),
});
export type PresenceView = z.infer<typeof PresenceView>;

/**
 * `new-device`: a display name already known under another key appeared with this key
 * (plan section 5); shown as "New device or unverified" until accepted.
 */
export const PeerTrust = z.enum(['normal', 'new-device', 'accepted']);
export type PeerTrust = z.infer<typeof PeerTrust>;

export const PersonView = z.object({
  userId: UserId,
  /** Undefined until the peer's signed profile has been fetched. */
  displayName: z.string().optional(),
  jobTitle: z.string().optional(),
  statusMessage: z.string().optional(),
  avatarHash: Sha256Hex.optional(),
  email: z.string().optional(),
  notes: z.string().optional(),
  workplace: z.enum(['office', 'home']).optional(),
  presence: PresenceState,
  /** In a call: shown as "In a call" instead of Busy. */
  inCall: z.boolean().optional(),
  online: z.boolean(),
  lastSeen: EpochMs,
  trust: PeerTrust,
  verified: z.boolean(),
  safetyPhrase: z.array(z.string()).length(6),
  /** When this PC first saw them. */
  firstSeen: EpochMs,
  /** The address they were last reached at on this network. */
  address: z.string().optional(),
  /** The InterCom version they last reported. */
  appVersion: z.string().max(32).optional(),
  /** Their PC, as it last reported itself. */
  machine: MachineInfo.optional(),
  /** When that was last reported (they may be offline now). */
  infoAt: EpochMs.optional(),
  /** Removed from the people list by the user (back when they are seen online). */
  hidden: z.boolean(),
});
export type PersonView = z.infer<typeof PersonView>;

export const ConversationView = z.object({
  convId: ConvId,
  kind: ConversationKind,
  /** For direct conversations: the other person. */
  peerUserId: UserId.optional(),
  title: z.string(),
  /** The one chat everyone on the network is in (kept in the list above the others). */
  broadcast: z.boolean().optional(),
  lastMessage: z.object({ author: UserId, text: z.string(), at: EpochMs }).optional(),
  lastActivityAt: EpochMs,
  /** Messages from others after this PC's read position. */
  unread: z.number().int().nonnegative(),
  notify: z.enum(['all', 'mentions', 'muted']),
  memberCount: z.number().int().nonnegative(),
  /** Channels: the team they belong to. */
  teamId: ConvId.optional(),
  private: z.boolean().optional(),
  archived: z.boolean().optional(),
  /** False once this PC's user was removed or left: history stays, nothing new arrives. */
  active: z.boolean(),
  /**
   * The chat of a call that has more than two people: it is in the call window, and stays out of
   * the chat list while the call goes on and, if nobody wrote anything, for good.
   */
  temporary: z.boolean().optional(),
  /** A group's picture: a small JPEG, base64. */
  picture: z.string().max(40_000).optional(),
});
export type ConversationView = z.infer<typeof ConversationView>;

/** `waiting`: the recipient is offline; the message is held until both are online together. */
/** `carried`: the recipient is offline and the message is sealed with colleagues (M6). */
export const DeliveryStatus = z.enum(['sending', 'waiting', 'carried', 'delivered', 'read']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/**
 * Where a message stands with each person it was sent to. Times are when this PC learned of it
 * (delivery) and when the reader's PC said it was read (seen); a time is absent when it happened
 * before this PC kept them, or has not happened yet.
 */
export const MessageRecipient = z.object({
  userId: UserId,
  delivered: z.boolean(),
  deliveredAt: EpochMs.optional(),
  seen: z.boolean(),
  seenAt: EpochMs.optional(),
});
export type MessageRecipient = z.infer<typeof MessageRecipient>;

export const MessageDetails = z.object({
  /** When the author wrote it. */
  sentAt: EpochMs,
  editedAt: EpochMs.optional(),
  /** Own messages only: one entry for each other member. */
  recipients: z.array(MessageRecipient).optional(),
});
export type MessageDetails = z.infer<typeof MessageDetails>;

export const ReactionView = z.object({
  emoji: z.string(),
  users: z.array(UserId),
  mine: z.boolean(),
});

export const RsvpResponse = z.enum(['accepted', 'tentative', 'declined']);

export const MessageView = z.object({
  /** `author:seq`, unique within the conversation. */
  id: z.string(),
  convId: ConvId,
  author: UserId,
  seq: z.number().int().min(1),
  hlc: Hlc,
  at: EpochMs,
  kind: z.enum(['text', 'file']),
  /** Restricted Markdown (empty when deleted). */
  text: z.string(),
  mine: z.boolean(),
  status: DeliveryStatus.optional(),
  mentions: z.array(UserId),
  mentionsMe: z.boolean(),
  urgent: z.boolean(),
  edited: z.boolean(),
  deleted: z.boolean(),
  pinned: z.boolean(),
  saved: z.boolean(),
  replyTo: z
    .object({ author: UserId, seq: z.number().int(), excerpt: z.string(), missing: z.boolean() })
    .optional(),
  forwarded: z.object({ from: z.string(), at: EpochMs }).optional(),
  file: FileRef.optional(),
  preview: LinkPreview.optional(),
  reactions: z.array(ReactionView),
  kindDetail: z.enum(['post', 'file', 'poll', 'meeting', 'call']),
  /** Channel replies: the root post they belong to. */
  thread: MsgRef.optional(),
  /** Root posts: number of replies and when the latest arrived. */
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: EpochMs.optional(),
  announcement: z.object({ headline: z.string() }).optional(),
  poll: z
    .object({
      question: z.string(),
      multi: z.boolean(),
      closed: z.boolean(),
      options: z.array(
        z.object({
          text: z.string(),
          votes: z.number().int(),
          mine: z.boolean(),
          /** Who chose it (not for a poll that hides names, nor while the counts are hidden). */
          voters: z.array(UserId).optional(),
        }),
      ),
      voters: z.number().int(),
      /** With `multi`: the most choices one person may make. */
      maxChoices: z.number().int().optional(),
      anonymous: z.boolean().optional(),
      results: z.enum(['always', 'voted', 'closed']).optional(),
      /** Set when the counts are not shown to this user yet: until they vote, or until it closes. */
      hidden: z.enum(['voted', 'closed']).optional(),
      closesAt: EpochMs.optional(),
      /** When it closed (by its author or at `closesAt`). */
      closedAt: EpochMs.optional(),
    })
    .optional(),
  /** A scheduled meeting card. */
  meeting: z
    .object({
      title: z.string(),
      start: EpochMs,
      end: EpochMs,
      recurrence: Recurrence,
      notes: z.string().optional(),
      cancelled: z.boolean(),
      cancelledOccurrences: z.array(EpochMs),
      rsvps: z.array(z.object({ userId: UserId, response: RsvpResponse })),
      myResponse: RsvpResponse.optional(),
    })
    .optional(),
  /** A "call started" card (Meet now, or a meeting in progress). */
  callCard: z
    .object({
      callId: CallId,
      media: CallMedia,
      ended: z.boolean(),
      meeting: MsgRef.optional(),
    })
    .optional(),
});
export type MessageView = z.infer<typeof MessageView>;

/** One occurrence of a scheduled meeting, for the calendar. */
export const MeetingOccurrence = z.object({
  convId: ConvId,
  conversation: z.string(),
  /** The `meeting.schedule` event. */
  target: MsgRef,
  organizer: UserId,
  title: z.string(),
  start: EpochMs,
  end: EpochMs,
  recurrence: Recurrence,
  notes: z.string().optional(),
  cancelled: z.boolean(),
  attendees: z.array(UserId),
  rsvps: z.array(z.object({ userId: UserId, response: RsvpResponse })),
  myResponse: RsvpResponse.optional(),
  /** A call is running for this meeting's conversation right now. */
  live: z.boolean(),
});
export type MeetingOccurrence = z.infer<typeof MeetingOccurrence>;

export const NetworkStatus = z.object({
  /** Windows Firewall allow rules for this app. */
  firewall: z.enum(['checking', 'ok', 'missing', 'unknown']),
  /** A connected network is set to Public, which hides this PC from colleagues. */
  publicNetwork: z.boolean(),
  discovery: z.enum(['off', 'ok', 'error']),
  linkPort: z.number().int().nullable(),
  onlinePeers: z.number().int().nonnegative(),
  /** Peers whose beacons were rejected for clock skew over 30 s. */
  clockSkewPeers: z.number().int().nonnegative(),
  /** Colleagues on other subnets linked now (M6). */
  remoteOnline: z.number().int().nonnegative().optional(),
  /** The newest app version a linked colleague runs, when newer than this one (M6). */
  newerVersion: z.string().max(32).optional(),
});
export type NetworkStatus = z.infer<typeof NetworkStatus>;

/** An update found in the shared update folder (plan section 15, M6) or in a GitHub release. */
export const UpdateStatus = z.object({
  state: z.enum(['off', 'checking', 'none', 'available', 'downloading', 'error']),
  /** Where it was found: the shared folder, or the GitHub release. */
  source: z.enum(['folder', 'github']).optional(),
  /**
   * Installing it is not optional: the window cannot be closed until it is (the office's folder,
   * or a release that says so).
   */
  required: z.boolean().optional(),
  /** The release page, to read what is new. */
  releaseUrl: z.string().max(300).optional(),
  /** Downloading: how much has arrived (percent). */
  progress: z.number().int().min(0).max(100).optional(),
  /** The newer version found, and the installer that carries it. */
  version: z.string().max(32).optional(),
  file: z.string().max(1000).optional(),
  /**
   * Authenticode check: `valid` (signed, and by this build's publisher if this build is
   * signed), `unsigned` (accepted only while this build is unsigned too), `invalid`.
   */
  signature: z.enum(['valid', 'unsigned', 'invalid']).optional(),
  publisher: z.string().max(300).optional(),
  checkedAt: EpochMs.optional(),
  error: z.string().max(500).optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

/** Everything on the Diagnostics page, and in an exported diagnostics file (M6). */
export const Diagnostics = z.object({
  generatedAt: EpochMs,
  app: AppInfo,
  system: z.object({
    os: z.string(),
    arch: z.string(),
    cpus: z.number().int(),
    memoryMb: z.number().int(),
    uptimeS: z.number().int(),
  }),
  network: NetworkStatus,
  interfaces: z.array(z.object({ name: z.string(), address: z.string(), netmask: z.string() })),
  peers: z.object({
    known: z.number().int(),
    online: z.number().int(),
    remote: z.number().int(),
    linked: z.number().int(),
  }),
  links: z.array(
    z.object({
      userId: UserId,
      name: z.string(),
      app: z.string(),
      remote: z.boolean(),
    }),
  ),
  manualPeers: z.array(
    z.object({ address: z.string(), userId: UserId.nullable(), linked: z.boolean() }),
  ),
  envelopes: z.object({
    carrying: z.number().int(),
    carryingBytes: z.number().int(),
    outgoing: z.number().int(),
  }),
  relay: z.object({
    capable: z.boolean(),
    score: z.number(),
    reason: z.string(),
    hosting: z.boolean(),
    participants: z.number().int(),
  }),
  store: z.object({
    databaseBytes: z.number().int(),
    events: z.number().int(),
    messages: z.number().int(),
    conversations: z.number().int(),
  }),
  memory: z.object({ rssMb: z.number(), heapMb: z.number() }),
  /** Most recent log lines, oldest first. */
  log: z.array(z.string()),
});
export type Diagnostics = z.infer<typeof Diagnostics>;

export const FileStatus = z.object({
  sha256: Sha256Hex,
  /** `gone`: this PC had the file and it is no longer where it was (deleted, or changed). */
  state: z.enum(['missing', 'downloading', 'complete', 'unavailable', 'failed', 'gone']),
  received: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  error: z.string().optional(),
  /** While downloading: the recent speed, and the time left at that speed (null: stalled). */
  bytesPerSecond: z.number().nonnegative().optional(),
  etaSeconds: z.number().int().nonnegative().nullable().optional(),
});
export type FileStatus = z.infer<typeof FileStatus>;

/** A colleague this PC is sending a file to right now. */
export const FileUpload = z.object({
  userId: UserId,
  sent: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  bytesPerSecond: z.number().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
});
export type FileUpload = z.infer<typeof FileUpload>;

export const ActivityItem = z.object({
  id: z.number().int(),
  kind: z.enum(['mention', 'reply', 'reaction', 'missed-call']),
  convId: ConvId,
  author: UserId,
  /** The message to open: the mention or reply itself, or the message reacted to. Absent for a missed call. */
  target: MsgRef.optional(),
  excerpt: z.string(),
  emoji: z.string().optional(),
  at: EpochMs,
  read: z.boolean(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const SearchHit = z.object({
  message: MessageView,
  /** Plain-text excerpt; matches wrapped in U+0001 ... U+0002. */
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const Settings = z.object({
  startWithWindows: z.boolean(),
  /** Chosen call devices (`deviceId`s); empty means the Windows default. */
  audioInput: z.string().max(512),
  audioOutput: z.string().max(512),
  videoInput: z.string().max(512),
  /** Colleagues on other subnets, by address ("ip" or "ip:port"), kept linked (M6). */
  peerAddresses: z.array(z.string().max(64)).max(32),
  /** A shared folder checked for a newer installer (empty: none) (M6). */
  updateFolder: z.string().max(400),
  /** Look for new versions in the project's GitHub releases (on by default). */
  githubUpdates: z.boolean(),
  /** Whether this PC may host large meetings' media relay (M6). */
  relayHosting: z.enum(['auto', 'never']),
  /** Where received files are saved (always a real folder; the default is Downloads\InterCom). */
  saveFolder: z.string().max(1000),
  /** Light, dark, or whatever Windows is set to. */
  theme: z.enum(['system', 'light', 'dark']),
  /** The app's look: colours and roundness (the layout is the same in each). */
  look: z.enum(['classic', 'harbor', 'paper']),
  /** The accent colour as `#rrggbb`; empty means the look's own. */
  accent: z.string().regex(/^(#[0-9a-fA-F]{6})?$/),
  /** Save files colleagues send as soon as they arrive (on by default), or wait for a click. */
  autoReceive: z.boolean(),
  /** Calls: how hard to suppress background sound (noise, other voices, far-away sound). */
  noiseSuppression: z.enum(['off', 'standard', 'high']),
});
export type Settings = z.infer<typeof Settings>;

const Target = z.object({ convId: ConvId, target: MsgRef });

export const CallParticipantView = CallParticipant.extend({
  name: z.string(),
  avatarHash: Sha256Hex.optional(),
});
export type CallParticipantView = z.infer<typeof CallParticipantView>;

/**
 * Remote help (M6.18) with one colleague, over the Windows session sharing API. `sharer` is this PC's
 * role when its desktop is the one shown; `viewer` when it shows the colleague's.
 */
export const AssistView = z.object({
  sessionId: AssistSessionId,
  peer: UserId,
  kind: AssistKind,
  /** This user asked (rather than being asked). */
  mine: z.boolean(),
  role: z.enum(['sharer', 'viewer']),
  /**
   * asking: waiting for the colleague's answer; asked: waiting for this user's; starting:
   * accepted, the sharing or viewing helper is starting; open: it is running (the sharer's is
   * waiting for, or connected to, the helper); ended.
   */
  state: z.enum(['asking', 'asked', 'starting', 'open', 'ended']),
  endReason: z
    .enum([
      'declined',
      'cancelled',
      'busy',
      'no-answer',
      'closed',
      'lost',
      'failed',
      'no-connection',
      'not-allowed',
      'unavailable',
      'old-version',
    ])
    .optional(),
  /**
   * Sharing side, once the colleague is connected: whether they may control this PC (false: they
   * can only look). Changed here (`assist.control`) or from the sharing helper's own menu.
   */
  control: z.boolean().optional(),
  /** Whether the colleague or this user ended or declined it (with `endReason`). */
  endedBy: z.enum(['me', 'peer']).optional(),
  at: EpochMs,
});
export type AssistView = z.infer<typeof AssistView>;

/** Whether this PC can do remote help. */
export const AssistStatus = z.object({
  /** The remote help helper and Windows' session sharing components are there. */
  available: z.boolean(),
  /** "Allow Remote Assistance connections to this computer" is on (and no policy turns it off). */
  allowed: z.boolean(),
});
export type AssistStatus = z.infer<typeof AssistStatus>;

/** One thing that happened between this user and a colleague: a message, a file or a call. */
export const PersonActivityItem = z.object({
  kind: z.enum(['message', 'file', 'call']),
  at: EpochMs,
  /** The message (cut short) or the file's name; empty for a call. */
  text: z.string(),
  /** Sent, or placed, by this user. */
  mine: z.boolean(),
  media: CallMedia.optional(),
  outcome: z
    .enum(['completed', 'missed', 'declined', 'no-answer', 'busy', 'dnd', 'cancelled'])
    .optional(),
  /** How long an answered call lasted. */
  durationMs: z.number().int().nonnegative().optional(),
});
export type PersonActivityItem = z.infer<typeof PersonActivityItem>;

/** What this user and a colleague have done together: the page of a person shows it. */
export const PersonActivity = z.object({
  /** Their direct chat, when there is one. */
  convId: ConvId.optional(),
  messages: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  missedCalls: z.number().int().nonnegative(),
  /** Time spent in answered calls with them. */
  talkMs: z.number().int().nonnegative(),
  firstContactAt: EpochMs.optional(),
  /** The latest of all of it, newest first. */
  recent: z.array(PersonActivityItem).max(12),
  /** Groups both are in. */
  groups: z.array(z.object({ convId: ConvId, title: z.string() })).max(20),
});
export type PersonActivity = z.infer<typeof PersonActivity>;

/** The call this PC is ringing for, placing or in (at most one at a time). */
export const CallView = z.object({
  callId: CallId,
  convId: ConvId.optional(),
  /** The temporary chat of a call of three or more (shown in the call window in place of `convId`). */
  chat: ConvId.optional(),
  media: CallMedia,
  direction: z.enum(['in', 'out']),
  /** ringing: an invitation to us; outgoing: we are calling and nobody has joined yet. */
  state: z.enum(['ringing', 'outgoing', 'active']),
  /** Who invited us (incoming) or whom we are calling (outgoing). */
  caller: UserId,
  invited: z.array(UserId),
  /** Who started the call: may mute everyone, remove people and spotlight. */
  organizer: UserId,
  /** Everyone in the call, including this user, without those who left. */
  participants: z.array(CallParticipantView),
  /** Why an invitee is not coming. */
  declines: z.array(z.object({ userId: UserId, reason: CallDeclineReason })),
  startedAt: EpochMs,
  answeredAt: EpochMs.optional(),
  /**
   * On host relay (M6): who hosts the media and which hand-over this is (`epoch` rises at
   * each), the most people the meeting may hold, and whether the host is being replaced.
   */
  relay: RelayRef.extend({
    max: z.number().int(),
    reconnecting: z.boolean(),
  }).optional(),
  /** Ringing while this user is busy in another call (answer it, add it or decline it). */
  waiting: z.boolean().optional(),
  /** Put on hold to take another call; it keeps running. */
  held: z.boolean().optional(),
});
export type CallView = z.infer<typeof CallView>;

export const CallOutcome = z.enum([
  'completed',
  'missed',
  'declined',
  'no-answer',
  'busy',
  'dnd',
  'cancelled',
]);
export const CallHistoryItem = z.object({
  callId: CallId,
  convId: ConvId.optional(),
  direction: z.enum(['in', 'out']),
  media: CallMedia,
  peers: z.array(UserId),
  startedAt: EpochMs,
  answeredAt: EpochMs.optional(),
  endedAt: EpochMs.optional(),
  outcome: CallOutcome.optional(),
});
export type CallHistoryItem = z.infer<typeof CallHistoryItem>;

/** A WebRTC signal between two participants, relayed (and signed, for SDP) by the core. */
export const CallSignal = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sdp'),
    type: z.enum(['offer', 'answer']),
    sdp: z.string().max(100_000),
  }),
  z.object({ kind: z.literal('ice'), candidate: IceCandidate.nullable() }),
]);
export type CallSignal = z.infer<typeof CallSignal>;

export const ScreenSource = z.object({
  id: z.string().max(200),
  name: z.string().max(300),
  kind: z.enum(['screen', 'window']),
  /** PNG data URL, about 320 pixels wide. */
  thumbnail: z.string().max(2_000_000),
});
export type ScreenSource = z.infer<typeof ScreenSource>;

export const MemberView = z.object({
  userId: UserId,
  name: z.string(),
  role: z.enum(['owner', 'member']),
  online: z.boolean(),
  avatarHash: Sha256Hex.optional(),
});
export type MemberView = z.infer<typeof MemberView>;

export const TeamView = z.object({
  teamId: ConvId,
  name: z.string(),
  description: z.string().optional(),
  visibility: z.enum(['public', 'private']),
  /** This PC's user's role, or undefined if no longer a member. */
  role: z.enum(['owner', 'member']).optional(),
  memberCount: z.number().int(),
  channels: z.array(ConversationView),
});
export type TeamView = z.infer<typeof TeamView>;

export const PublicTeamView = z.object({ teamId: ConvId, name: z.string(), via: z.array(UserId) });
export type PublicTeamView = z.infer<typeof PublicTeamView>;

export const FileListItem = z.object({
  sha256: Sha256Hex,
  name: z.string(),
  size: z.number().int(),
  mime: z.string(),
  convId: ConvId,
  conversation: z.string(),
  author: UserId,
  at: EpochMs,
  message: MsgRef,
  state: FileStatus.shape.state,
});
export type FileListItem = z.infer<typeof FileListItem>;

export const CoreStatus = z.object({
  state: z.enum(['starting', 'ready', 'error']),
  message: z.string().optional(),
});
export type CoreStatus = z.infer<typeof CoreStatus>;

// ---------------------------------------------------------------------------
// Commands and events
// ---------------------------------------------------------------------------

const NoArgs = z.object({}).strict();

export const ipcCommands = {
  'app.info': { input: NoArgs, output: AppInfo },
  'identity.get': { input: NoArgs, output: IdentityView },
  'profile.update': { input: ProfileEdit, output: IdentityView },
  'presence.get': { input: NoArgs, output: PresenceView },
  'presence.set': { input: z.object({ state: ManualPresenceState }), output: PresenceView },
  'people.list': { input: NoArgs, output: z.array(PersonView) },
  'people.setTrust': {
    input: z.object({
      userId: UserId,
      accept: z.boolean().optional(),
      verified: z.boolean().optional(),
    }),
    output: PersonView,
  },
  'conversations.list': { input: NoArgs, output: z.array(ConversationView) },
  'conversations.openDirect': { input: z.object({ userId: UserId }), output: ConversationView },
  'messages.list': {
    input: z.object({
      convId: ConvId,
      limit: z.number().int().min(1).max(500).optional(),
      /** Return messages strictly before this position (for scrolling back). */
      before: z.object({ hlc: Hlc, author: UserId }).optional(),
      /** Channels: only root posts (replies are fetched per thread). */
      rootsOnly: z.boolean().optional(),
    }),
    output: z.array(MessageView),
  },
  'messages.send': {
    input: z.object({
      convId: ConvId,
      text: z.string().max(MAX_MESSAGE_TEXT),
      mentions: z.array(UserId).max(50).optional(),
      replyTo: MsgRef.optional(),
      urgent: z.boolean().optional(),
      preview: LinkPreview.optional(),
      thread: MsgRef.optional(),
      announcement: z.object({ headline: z.string().trim().min(1).max(120) }).optional(),
    }),
    output: MessageView,
  },
  'messages.edit': {
    input: Target.extend({
      text: z.string().max(MAX_MESSAGE_TEXT),
      mentions: z.array(UserId).max(50).optional(),
    }),
    output: MessageView,
  },
  'messages.delete': { input: Target, output: MessageView },
  'messages.react': {
    input: Target.extend({ emoji: z.string().min(1).max(32), on: z.boolean() }),
    output: MessageView,
  },
  'messages.pin': { input: Target.extend({ on: z.boolean() }), output: MessageView },
  /** Saved messages are private to this PC. */
  'messages.save': { input: Target.extend({ on: z.boolean() }), output: MessageView },
  'messages.forward': { input: Target.extend({ toConvId: ConvId }), output: MessageView },
  'messages.markRead': { input: z.object({ convId: ConvId }), output: z.object({}) },
  'messages.pinned': { input: z.object({ convId: ConvId }), output: z.array(MessageView) },
  'messages.saved': { input: NoArgs, output: z.array(MessageView) },
  /** Messages around one message (for opening a search hit or activity item). */
  'messages.context': { input: Target, output: z.array(MessageView) },
  /** When a message reached and was seen by each other member (own messages), for "Details". */
  'messages.details': { input: Target, output: MessageDetails },
  'typing.notify': { input: z.object({ convId: ConvId }), output: z.object({}) },
  'files.share': {
    input: z.object({
      convId: ConvId,
      /** A local path the user picked or dropped (from the preload's file-path helper). */
      path: z.string().min(1).max(32_767).optional(),
      /** Bytes, for pasted images and snips (up to 25 MB). */
      data: z.instanceof(Uint8Array).optional(),
      name: z.string().min(1).max(255).optional(),
      mime: z.string().max(127).optional(),
      text: z.string().max(MAX_MESSAGE_TEXT).optional(),
      mentions: z.array(UserId).max(50).optional(),
      replyTo: MsgRef.optional(),
      urgent: z.boolean().optional(),
      thumb: z.string().max(48_000).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      /** A token for `files.preparing` progress while a big file is read. */
      prepareId: z.string().max(64).optional(),
      /** In a channel: the root post this file is a reply to. */
      thread: MsgRef.optional(),
    }),
    output: MessageView,
  },
  /** Ask the user for the folder received files are saved to (a folder dialog). */
  'files.pickFolder': { input: NoArgs, output: z.object({ path: z.string().nullable() }) },
  'files.showSaveFolder': { input: NoArgs, output: z.object({}) },
  'files.download': { input: z.object({ sha256: Sha256Hex }), output: FileStatus },
  'files.cancel': { input: z.object({ sha256: Sha256Hex }), output: FileStatus },
  'files.status': {
    input: z.object({ sha256s: z.array(Sha256Hex).max(500) }),
    output: z.array(FileStatus),
  },
  'files.open': { input: z.object({ sha256: Sha256Hex }), output: z.object({}) },
  'files.showInFolder': { input: z.object({ sha256: Sha256Hex }), output: z.object({}) },
  'links.preview': {
    input: z.object({ url: z.string().max(2_048) }),
    output: LinkPreview.nullable(),
  },
  'search.query': {
    input: z.object({
      text: z.string().max(200),
      from: UserId.optional(),
      convId: ConvId.optional(),
      hasFile: z.boolean().optional(),
      after: EpochMs.optional(),
      before: EpochMs.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    output: z.object({ messages: z.array(SearchHit), tookMs: z.number() }),
  },
  'activity.list': { input: NoArgs, output: z.array(ActivityItem) },
  'activity.markRead': {
    input: z.object({ ids: z.array(z.number().int()).max(1_000).optional() }),
    output: z.object({}),
  },
  'notifications.setLevel': {
    input: z.object({ convId: ConvId, level: z.enum(['all', 'mentions', 'muted']) }),
    output: ConversationView,
  },
  'settings.get': { input: NoArgs, output: Settings },
  'settings.set': { input: Settings.partial(), output: Settings },
  'profile.setAvatar': {
    input: z.object({
      data: z.instanceof(Uint8Array),
      mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    }),
    output: IdentityView,
  },
  /** What the user is looking at: suppresses toasts and drives read state. */
  'ui.state': {
    input: z.object({ activeConvId: ConvId.nullable(), windowFocused: z.boolean() }),
    output: z.object({}),
  },
  'screen.snip': { input: NoArgs, output: z.object({}) },
  'messages.thread': { input: Target, output: z.array(MessageView) },
  'groups.create': {
    input: z.object({
      members: z.array(UserId).min(1).max(249),
      title: z.string().trim().max(100).optional(),
    }),
    output: ConversationView,
  },
  'conversations.members': { input: z.object({ convId: ConvId }), output: z.array(MemberView) },
  'conversations.addMembers': {
    input: z.object({ convId: ConvId, userIds: z.array(UserId).min(1).max(249) }),
    output: z.array(MemberView),
  },
  'conversations.removeMember': {
    input: z.object({ convId: ConvId, userId: UserId }),
    output: z.array(MemberView),
  },
  /** Take offline colleagues off the people list (or put one back). Chats are not touched. */
  'people.hide': {
    input: z.object({ userIds: z.array(UserId).min(1).max(1_000), hidden: z.boolean() }),
    output: z.array(PersonView),
  },
  'conversations.leave': { input: z.object({ convId: ConvId }), output: z.object({}) },
  /**
   * Delete a chat's history from this PC (chats and groups, not channels). The other people keep
   * theirs; a new message from them starts the chat again.
   */
  'conversations.delete': { input: z.object({ convId: ConvId }), output: z.object({}) },
  'conversations.setPicture': {
    input: z.object({ convId: ConvId, picture: z.string().max(40_000) }),
    output: ConversationView,
  },
  'conversations.rename': {
    input: z.object({ convId: ConvId, title: z.string().trim().min(1).max(100) }),
    output: ConversationView,
  },
  'teams.list': { input: NoArgs, output: z.array(TeamView) },
  'teams.create': {
    input: z.object({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(500).optional(),
      visibility: z.enum(['public', 'private']),
      members: z.array(UserId).max(249),
    }),
    output: TeamView,
  },
  'teams.rename': {
    input: z.object({
      teamId: ConvId,
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(500).optional(),
    }),
    output: TeamView,
  },
  'teams.setRole': {
    input: z.object({ teamId: ConvId, userId: UserId, role: z.enum(['owner', 'member']) }),
    output: z.array(MemberView),
  },
  'teams.discover': { input: NoArgs, output: z.array(PublicTeamView) },
  'teams.join': { input: z.object({ teamId: ConvId }), output: TeamView },
  'channels.create': {
    input: z.object({
      teamId: ConvId,
      name: z.string().trim().min(1).max(60),
      description: z.string().trim().max(300).optional(),
      private: z.boolean(),
      members: z.array(UserId).max(249).optional(),
    }),
    output: ConversationView,
  },
  'channels.rename': {
    input: z.object({ teamId: ConvId, channelId: ConvId, name: z.string().trim().min(1).max(60) }),
    output: ConversationView,
  },
  'channels.archive': {
    input: z.object({ teamId: ConvId, channelId: ConvId, archived: z.boolean() }),
    output: ConversationView,
  },
  'polls.create': {
    input: z.object({
      convId: ConvId,
      question: z.string().trim().min(1).max(300),
      options: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
      multi: z.boolean().optional(),
      thread: MsgRef.optional(),
      maxChoices: z.number().int().min(2).max(10).optional(),
      anonymous: z.boolean().optional(),
      results: z.enum(['always', 'voted', 'closed']).optional(),
      closesAt: EpochMs.optional(),
    }),
    output: MessageView,
  },
  'polls.vote': {
    input: Target.extend({ choices: z.array(z.number().int().min(0).max(9)).max(10) }),
    output: MessageView,
  },
  'polls.close': { input: Target, output: MessageView },
  'files.list': { input: z.object({ convId: ConvId.optional() }), output: z.array(FileListItem) },
  'network.status': { input: NoArgs, output: NetworkStatus },
  'network.fixFirewall': { input: NoArgs, output: NetworkStatus },
  'network.openSettings': { input: NoArgs, output: z.object({}) },
  /** Link to a colleague on another subnet by address, and keep it in Settings (M6). */
  'network.addPeer': {
    input: z.object({ address: z.string().min(1).max(64) }),
    output: z.object({ userId: UserId.nullable(), name: z.string().optional() }),
  },
  /** Seal this profile (key and history) under a passphrase, for moving PCs (M6). */
  'profile.export': {
    input: z.object({ passphrase: z.string().min(8).max(200) }),
    output: z.object({ path: z.string() }),
  },
  /** Ask the user for a profile file to import (a file dialog). */
  'profile.pickImport': { input: NoArgs, output: z.object({ path: z.string().nullable() }) },
  /**
   * Check and stage a profile file; it replaces this profile when the app restarts. The
   * current profile is kept in a backup folder.
   */
  'profile.import': {
    input: z.object({ path: z.string().min(1).max(1000), passphrase: z.string().min(1).max(200) }),
    output: z.object({ userId: UserId, displayName: z.string() }),
  },
  'app.restart': { input: NoArgs, output: z.object({}) },
  'diagnostics.get': { input: NoArgs, output: Diagnostics },
  /** Write diagnostics and recent logs to a text file in Downloads, and show it. */
  'diagnostics.export': { input: NoArgs, output: z.object({ path: z.string() }) },
  'updates.status': { input: NoArgs, output: UpdateStatus },
  /**
   * Look for an update. `manual` is the user pressing "Check for updates": GitHub is asked now
   * (not only every 6 hours) and a failure is reported instead of kept quiet.
   */
  'updates.check': {
    input: z.object({ manual: z.boolean().optional() }).strict(),
    output: UpdateStatus,
  },
  /** Run the installer found by the check; the app closes for it. */
  'updates.install': { input: NoArgs, output: z.object({}) },
  'calls.start': {
    input: z.object({
      convId: ConvId.optional(),
      userIds: z.array(UserId).min(1).max(11),
      media: CallMedia,
    }),
    output: CallView,
  },
  /**
   * Answer a ringing call. If this user is in another call, `how` says what happens to it:
   * `hold` puts it on hold, `end` hangs it up.
   */
  'calls.accept': {
    input: z.object({
      callId: CallId,
      video: z.boolean(),
      how: z.enum(['hold', 'end']).optional(),
    }),
    output: CallView,
  },
  /** Add the caller of a waiting call to the call this user is in (the waiting call is declined). */
  'calls.merge': { input: z.object({ callId: CallId }), output: CallView },
  /** Take a call off hold; the call this user is in (if any) goes on hold. */
  'calls.resume': { input: z.object({ callId: CallId }), output: CallView },
  /** Every call this PC is in, ringing for, or has on hold. */
  'calls.list': { input: NoArgs, output: z.array(CallView) },
  /**
   * How a call that has just ended ended (kept for a minute). A call window that opens after a
   * call failed instantly (Do not disturb, nobody there) asks, since it missed `call.ended`.
   */
  'calls.ended': {
    input: z.object({ callId: CallId }),
    output: z
      .object({
        outcome: CallOutcome,
        declines: z.array(z.object({ userId: UserId, reason: CallDeclineReason })),
        call: CallView,
      })
      .nullable(),
  },
  'calls.decline': { input: z.object({ callId: CallId }), output: z.object({}) },
  /** Remote help (M6.18): the sessions with colleagues, newest last (ended ones until dismissed). */
  'assist.list': { input: NoArgs, output: z.array(AssistView) },
  'assist.status': { input: NoArgs, output: AssistStatus },
  /** Ask a colleague: to help (they see this desktop) or to let this user into theirs. */
  'assist.request': {
    input: z.object({ userId: UserId, kind: AssistKind }),
    output: AssistView,
  },
  'assist.accept': { input: z.object({ sessionId: AssistSessionId }), output: AssistView },
  'assist.decline': { input: z.object({ sessionId: AssistSessionId }), output: AssistView },
  /** Sharing side of an open session: let the colleague control this PC, or only look. */
  'assist.control': {
    input: z.object({ sessionId: AssistSessionId, on: z.boolean() }),
    output: AssistView,
  },
  /** Cancel a request, or end a session (closes the sharing and viewing windows on both PCs). */
  'assist.end': { input: z.object({ sessionId: AssistSessionId }), output: AssistView },
  /** Forget an ended session. */
  'assist.dismiss': { input: z.object({ sessionId: AssistSessionId }), output: z.object({}) },
  /** Open Windows' Remote settings (System Properties), where Remote Assistance is turned on. */
  'assist.openSettings': { input: NoArgs, output: z.object({}) },
  'calls.hangup': { input: z.object({ callId: CallId }), output: z.object({}) },
  /** The organiser ends the call for everyone; anyone else just leaves with `calls.hangup`. */
  'calls.endForAll': { input: z.object({ callId: CallId }), output: z.object({}) },
  'calls.invite': {
    input: z.object({ callId: CallId, userIds: z.array(UserId).min(1).max(11) }),
    output: CallView,
  },
  /** This user's own roster entry changed (mute, camera, share, hold, started speaking). */
  'calls.update': {
    input: z.object({
      callId: CallId,
      muted: z.boolean().optional(),
      video: z.boolean().optional(),
      sharing: z.boolean().optional(),
      onHold: z.boolean().optional(),
      spoke: z.boolean().optional(),
      hand: z.boolean().optional(),
      recording: z.boolean().optional(),
    }),
    output: z.object({}),
  },
  /** Meet now: start a call in a chat or channel (or join the one already running there). */
  'calls.meetNow': {
    input: z.object({ convId: ConvId, media: CallMedia, meeting: MsgRef.optional() }),
    output: CallView,
  },
  /** Join the call a "call started" card announces. */
  'calls.join': { input: z.object({ convId: ConvId, target: MsgRef }), output: CallView },
  'calls.react': {
    input: z.object({ callId: CallId, emoji: z.enum(CALL_REACTIONS) }),
    output: z.object({}),
  },
  /** Organiser only: mute one or everyone, remove someone, spotlight someone (null clears). */
  'calls.control': {
    input: z.object({
      callId: CallId,
      action: z.enum(['mute', 'remove', 'spotlight']),
      target: UserId.nullable().optional(),
    }),
    output: z.object({}),
  },
  /** A media request to the call's relay host (M6); the core forwards it over the link. */
  'calls.relay': {
    input: z.object({
      callId: CallId,
      epoch: z.number().int().min(1),
      method: z.enum([
        'capabilities',
        'createTransport',
        'connectTransport',
        'produce',
        'closeProducer',
        'pauseProducer',
        'resumeConsumer',
        'setView',
      ] satisfies RelayMethod[]),
      data: z.unknown(),
    }),
    output: z.unknown(),
  },
  'meetings.schedule': {
    input: z.object({
      title: z.string().trim().min(1).max(200),
      start: EpochMs,
      end: EpochMs,
      recurrence: Recurrence,
      notes: z.string().max(4_000).optional(),
      /** Post it in this chat or channel; otherwise a meeting chat is created for the invitees. */
      convId: ConvId.optional(),
      invitees: z.array(UserId).max(249).optional(),
    }),
    output: z.object({ convId: ConvId, target: MsgRef }),
  },
  'meetings.list': {
    input: z.object({ from: EpochMs, to: EpochMs }),
    output: z.array(MeetingOccurrence),
  },
  'meetings.update': {
    input: z.object({
      convId: ConvId,
      target: MsgRef,
      title: z.string().trim().min(1).max(200),
      start: EpochMs,
      end: EpochMs,
      recurrence: Recurrence,
      notes: z.string().max(4_000).optional(),
    }),
    output: z.object({}),
  },
  'meetings.cancel': {
    input: z.object({ convId: ConvId, target: MsgRef, occurrence: EpochMs.optional() }),
    output: z.object({}),
  },
  'meetings.rsvp': {
    input: z.object({ convId: ConvId, target: MsgRef, response: RsvpResponse }),
    output: z.object({}),
  },
  /** A local meeting recording, written in pieces while it runs, then shared to the chat. */
  'recordings.begin': {
    input: z.object({
      name: z.string().min(1).max(200),
      mime: z.enum(['video/mp4', 'video/webm']),
    }),
    output: z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }),
  },
  'recordings.append': {
    input: z.object({
      id: z.string().regex(/^[0-9a-f]{32}$/),
      data: z.instanceof(Uint8Array).refine((d) => d.length <= 64 * 1024 * 1024),
    }),
    output: z.object({}),
  },
  'recordings.finish': {
    input: z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), convId: ConvId }),
    output: MessageView,
  },
  'recordings.abort': {
    input: z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }),
    output: z.object({}),
  },
  /** Write the meeting as an .ics file to Downloads and show it in Explorer. */
  'meetings.exportIcs': {
    input: z.object({ convId: ConvId, target: MsgRef }),
    output: z.object({ path: z.string() }),
  },
  'calls.signal': {
    input: z.object({ callId: CallId, to: UserId, signal: CallSignal }),
    output: z.object({}),
  },
  /** The media connection to a participant failed (no heartbeat): drop them from the call. */
  'calls.dropped': { input: z.object({ callId: CallId, userId: UserId }), output: z.object({}) },
  'calls.current': { input: NoArgs, output: CallView.nullable() },
  'calls.history': { input: NoArgs, output: z.array(CallHistoryItem) },
  /** What this user and a colleague have done together (for the colleague's page). */
  'people.activity': { input: z.object({ userId: UserId }), output: PersonActivity },
  'screen.sources': { input: NoArgs, output: z.array(ScreenSource) },
  /** Draw (or with null, remove) the coloured border around a shared screen. */
  'screen.border': {
    input: z.object({ sourceId: z.string().max(200).nullable() }),
    output: z.object({}),
  },
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export const ipcEvents = {
  'core.status': CoreStatus,
  'identity.changed': IdentityView,
  'presence.changed': PresenceView,
  /** Upserts: only people whose view changed. */
  'people.changed': z.object({ people: z.array(PersonView) }),
  'conversations.changed': z.object({ conversations: z.array(ConversationView) }),
  'messages.added': z.object({ convId: ConvId, messages: z.array(MessageView) }),
  /** Delivery status changes for messages already shown. */
  'messages.updated': z.object({ convId: ConvId, messages: z.array(MessageView) }),
  'network.changed': NetworkStatus,
  typing: z.object({ convId: ConvId, userId: UserId }),
  'files.progress': FileStatus,
  /** Who this PC is sending a file to, and how far along each is (empty: finished). */
  'files.upload': z.object({ sha256: Sha256Hex, uploads: z.array(FileUpload) }),
  /** Hashing a big file before it is shared (`prepareId` is the caller's own token). */
  'files.preparing': z.object({
    prepareId: z.string().max(64),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  'activity.changed': z.object({ items: z.array(ActivityItem), unread: z.number().int() }),
  /** Open a conversation, at a message if given (toast clicks). */
  'ui.open': z.object({ convId: ConvId, target: MsgRef.optional() }),
  'settings.changed': Settings,
  'teams.changed': z.object({ teams: z.array(TeamView) }),
  /** Membership changed what is visible: reload this conversation's messages. */
  'conversation.reset': z.object({ convId: ConvId }),
  /** Remote help sessions changed (all of them). */
  'assist.changed': z.array(AssistView),
  /** The person pressed "Call" in a remote help window: ring that colleague. */
  'assist.call': z.object({ userId: UserId }),
  /** This PC's own facts changed (someone connected with Remote Desktop, or left). */
  'machine.changed': MachineInfo,
  /** A call changed; `call: null` with a `callId` says that call is over. */
  'call.changed': z.object({ call: CallView.nullable(), callId: CallId.optional() }),
  /** The current call ended; `declines` says why invitees did not join. */
  'call.ended': z.object({
    callId: CallId,
    outcome: CallOutcome,
    declines: z.array(z.object({ userId: UserId, reason: CallDeclineReason })),
  }),
  'call.signal': z.object({ callId: CallId, from: UserId, signal: CallSignal }),
  'call.reaction': z.object({ callId: CallId, from: UserId, emoji: z.enum(CALL_REACTIONS) }),
  /** The organiser muted or removed this user. */
  'call.controlled': z.object({ callId: CallId, action: z.enum(['mute', 'remove', 'end']) }),
  /** Meetings changed (scheduled, updated, cancelled, answered): reload the calendar. */
  'meetings.changed': z.object({}),
  'calls.history.changed': z.object({ items: z.array(CallHistoryItem) }),
  'updates.changed': UpdateStatus,
  /** From the call's relay host: consumers to create, speakers, pauses (M6). */
  'call.relay': z.object({
    callId: CallId,
    epoch: z.number().int(),
    method: z.enum(Object.keys(RELAY_NOTIFY_DATA) as [RelayNotifyMethod, ...RelayNotifyMethod[]]),
    data: z.unknown(),
  }),
  /** This PC hosts the relay: its load, for the host's indicator. */
  'call.relayStats': z.object({
    callId: CallId,
    cpuPercent: z.number(),
    sendMbps: z.number(),
    recvMbps: z.number(),
    participants: z.number().int(),
    workers: z.number().int(),
  }),
} as const satisfies Record<string, z.ZodType>;

export type IpcCommandName = keyof typeof ipcCommands;
export type IpcEventName = keyof typeof ipcEvents;
export type IpcInput<N extends IpcCommandName> = z.input<(typeof ipcCommands)[N]['input']>;
export type IpcOutput<N extends IpcCommandName> = z.output<(typeof ipcCommands)[N]['output']>;
export type IpcEventPayload<N extends IpcEventName> = z.output<(typeof ipcEvents)[N]>;

export function isIpcCommandName(name: string): name is IpcCommandName {
  return Object.hasOwn(ipcCommands, name);
}

export function isIpcEventName(name: string): name is IpcEventName {
  return Object.hasOwn(ipcEvents, name);
}

// ---------------------------------------------------------------------------
// Frames on the port
// ---------------------------------------------------------------------------

export const IpcErrorCode = z.enum(['bad_request', 'unknown_command', 'not_ready', 'internal']);
export type IpcErrorCode = z.infer<typeof IpcErrorCode>;

export const IpcError = z.object({ code: IpcErrorCode, message: z.string() });
export type IpcError = z.infer<typeof IpcError>;

export const IpcRequestFrame = z.object({
  kind: z.literal('req'),
  id: z.number().int().nonnegative(),
  name: z.string().max(64),
  args: z.unknown(),
});
export type IpcRequestFrame = z.infer<typeof IpcRequestFrame>;

export const IpcResponseFrame = z.object({
  kind: z.literal('res'),
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: IpcError.optional(),
});
export type IpcResponseFrame = z.infer<typeof IpcResponseFrame>;

export const IpcEventFrame = z.object({
  kind: z.literal('evt'),
  name: z.string().max(64),
  payload: z.unknown(),
});
export type IpcEventFrame = z.infer<typeof IpcEventFrame>;

export const IpcFrame = z.discriminatedUnion('kind', [
  IpcRequestFrame,
  IpcResponseFrame,
  IpcEventFrame,
]);
export type IpcFrame = z.infer<typeof IpcFrame>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Anything that can carry frames: the preload bridge, a MessagePort, or a test pipe. */
export interface IpcTransport {
  send(frame: IpcFrame): void;
  onFrame(listener: (frame: unknown) => void): () => void;
}

export class IpcCallError extends Error {
  readonly code: IpcErrorCode;
  constructor(error: IpcError) {
    super(error.message);
    this.name = 'IpcCallError';
    this.code = error.code;
  }
}

export interface IpcClient {
  invoke<N extends IpcCommandName>(name: N, args: IpcInput<N>): Promise<IpcOutput<N>>;
  on<N extends IpcEventName>(name: N, listener: (payload: IpcEventPayload<N>) => void): () => void;
  dispose(): void;
}

export function createIpcClient(transport: IpcTransport): IpcClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { name: IpcCommandName; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const listeners = new Map<IpcEventName, Set<(payload: never) => void>>();

  const unsubscribe = transport.onFrame((raw) => {
    const parsed = IpcFrame.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === 'res') {
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      if (!frame.ok) {
        call.reject(
          new IpcCallError(frame.error ?? { code: 'internal', message: 'unknown error' }),
        );
        return;
      }
      const result = ipcCommands[call.name].output.safeParse(frame.result);
      if (result.success) call.resolve(result.data);
      else
        call.reject(
          new IpcCallError({ code: 'internal', message: `invalid result for ${call.name}` }),
        );
    } else if (frame.kind === 'evt') {
      if (!isIpcEventName(frame.name)) return;
      const payload = ipcEvents[frame.name].safeParse(frame.payload);
      if (!payload.success) return;
      for (const listener of listeners.get(frame.name) ?? []) listener(payload.data as never);
    }
  });

  return {
    invoke(name, args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { name, resolve: resolve as (v: unknown) => void, reject });
        transport.send({ kind: 'req', id, name, args });
      });
    },
    on(name, listener) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(listener as (payload: never) => void);
      return () => set.delete(listener as (payload: never) => void);
    },
    dispose() {
      unsubscribe();
      for (const call of pending.values()) {
        call.reject(new IpcCallError({ code: 'not_ready', message: 'client disposed' }));
      }
      pending.clear();
      listeners.clear();
    },
  };
}

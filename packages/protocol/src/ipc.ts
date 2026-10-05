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
} from './events.ts';
import { ManualPresenceState, PresenceState } from './presence.ts';
import { ProfileEdit } from './profile.ts';
import { CallDeclineReason, CallId, CallMedia, CallParticipant, IceCandidate } from './wire.ts';

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
});
export type AppInfo = z.infer<typeof AppInfo>;

export const PresenceView = z.object({
  /** What the user picked. */
  manual: ManualPresenceState,
  /** What colleagues see: manual, or Away while idle or locked. */
  effective: PresenceState,
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
  presence: PresenceState,
  online: z.boolean(),
  lastSeen: EpochMs,
  trust: PeerTrust,
  verified: z.boolean(),
  safetyPhrase: z.array(z.string()).length(6),
});
export type PersonView = z.infer<typeof PersonView>;

export const ConversationView = z.object({
  convId: ConvId,
  kind: ConversationKind,
  /** For direct conversations: the other person. */
  peerUserId: UserId.optional(),
  title: z.string(),
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
});
export type ConversationView = z.infer<typeof ConversationView>;

/** `waiting`: the recipient is offline; the message is held until both are online together. */
export const DeliveryStatus = z.enum(['sending', 'waiting', 'delivered', 'read']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const ReactionView = z.object({
  emoji: z.string(),
  users: z.array(UserId),
  mine: z.boolean(),
});

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
  kindDetail: z.enum(['post', 'file', 'poll']),
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
      options: z.array(z.object({ text: z.string(), votes: z.number().int(), mine: z.boolean() })),
      voters: z.number().int(),
    })
    .optional(),
});
export type MessageView = z.infer<typeof MessageView>;

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
});
export type NetworkStatus = z.infer<typeof NetworkStatus>;

export const FileStatus = z.object({
  sha256: Sha256Hex,
  state: z.enum(['missing', 'downloading', 'complete', 'unavailable', 'failed']),
  received: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type FileStatus = z.infer<typeof FileStatus>;

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
  readReceipts: z.boolean(),
  startWithWindows: z.boolean(),
  /** Chosen call devices (`deviceId`s); empty means the Windows default. */
  audioInput: z.string().max(512),
  audioOutput: z.string().max(512),
  videoInput: z.string().max(512),
});
export type Settings = z.infer<typeof Settings>;

const Target = z.object({ convId: ConvId, target: MsgRef });

export const CallParticipantView = CallParticipant.extend({
  name: z.string(),
  avatarHash: Sha256Hex.optional(),
});
export type CallParticipantView = z.infer<typeof CallParticipantView>;

/** The call this PC is ringing for, placing or in (at most one at a time). */
export const CallView = z.object({
  callId: CallId,
  convId: ConvId.optional(),
  media: CallMedia,
  direction: z.enum(['in', 'out']),
  /** ringing: an invitation to us; outgoing: we are calling and nobody has joined yet. */
  state: z.enum(['ringing', 'outgoing', 'active']),
  /** Who invited us (incoming) or whom we are calling (outgoing). */
  caller: UserId,
  invited: z.array(UserId),
  /** Everyone in the call, including this user, without those who left. */
  participants: z.array(CallParticipantView),
  /** Why an invitee is not coming. */
  declines: z.array(z.object({ userId: UserId, reason: CallDeclineReason })),
  startedAt: EpochMs,
  answeredAt: EpochMs.optional(),
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
    }),
    output: MessageView,
  },
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
  'conversations.leave': { input: z.object({ convId: ConvId }), output: z.object({}) },
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
  'calls.start': {
    input: z.object({
      convId: ConvId.optional(),
      userIds: z.array(UserId).min(1).max(11),
      media: CallMedia,
    }),
    output: CallView,
  },
  'calls.accept': { input: z.object({ callId: CallId, video: z.boolean() }), output: CallView },
  'calls.decline': { input: z.object({ callId: CallId }), output: z.object({}) },
  'calls.hangup': { input: z.object({ callId: CallId }), output: z.object({}) },
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
    }),
    output: z.object({}),
  },
  'calls.signal': {
    input: z.object({ callId: CallId, to: UserId, signal: CallSignal }),
    output: z.object({}),
  },
  /** The media connection to a participant failed (no heartbeat): drop them from the call. */
  'calls.dropped': { input: z.object({ callId: CallId, userId: UserId }), output: z.object({}) },
  'calls.current': { input: NoArgs, output: CallView.nullable() },
  'calls.history': { input: NoArgs, output: z.array(CallHistoryItem) },
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
  'activity.changed': z.object({ items: z.array(ActivityItem), unread: z.number().int() }),
  /** Open a conversation, at a message if given (toast clicks). */
  'ui.open': z.object({ convId: ConvId, target: MsgRef.optional() }),
  'settings.changed': Settings,
  'teams.changed': z.object({ teams: z.array(TeamView) }),
  /** Membership changed what is visible: reload this conversation's messages. */
  'conversation.reset': z.object({ convId: ConvId }),
  'call.changed': z.object({ call: CallView.nullable() }),
  /** The current call ended; `declines` says why invitees did not join. */
  'call.ended': z.object({
    callId: CallId,
    outcome: CallOutcome,
    declines: z.array(z.object({ userId: UserId, reason: CallDeclineReason })),
  }),
  'call.signal': z.object({ callId: CallId, from: UserId, signal: CallSignal }),
  'calls.history.changed': z.object({ items: z.array(CallHistoryItem) }),
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

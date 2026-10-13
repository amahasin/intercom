import { z } from 'zod';
import { Base64Url, EpochMs, PublicKeyB64, Sha256Hex, SignatureB64, UserId } from './common.ts';

/** Conversation IDs share the userId format: 32 lowercase base32 characters. */
export const ConvId = z.string().regex(/^[a-z2-7]{32}$/, 'invalid convId');
export type ConvId = z.infer<typeof ConvId>;

export const ConversationKind = z.enum(['direct', 'group', 'channel', 'team']);
export type ConversationKind = z.infer<typeof ConversationKind>;

/** Hybrid logical clock: wall-clock milliseconds plus a counter, for display order. */
export const Hlc = z.object({
  t: z.number().int().nonnegative(),
  c: z.number().int().nonnegative(),
});
export type Hlc = z.infer<typeof Hlc>;

/** Every event type the protocol defines. Bodies are added per milestone. */
export const EVENT_TYPES = [
  // Messages
  'msg.post',
  'msg.edit',
  'msg.delete',
  'msg.react',
  'msg.unreact',
  'msg.pin',
  'msg.unpin',
  'msg.read',
  // Polls
  'poll.create',
  'poll.vote',
  'poll.close',
  // Files
  'file.share',
  // Membership
  'member.add',
  'member.remove',
  'member.leave',
  'member.role',
  // Team control
  'group.create',
  'conv.rename',
  'team.create',
  'team.rename',
  'channel.create',
  'channel.rename',
  'channel.archive',
  // Meetings
  'meeting.schedule',
  'meeting.update',
  'meeting.cancel',
  'meeting.rsvp',
  'call.started',
  'call.ended',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * A signed, immutable entry in a per-conversation log. Event ID is `author:seq`.
 * `sig` covers the canonical JSON of every other field, as received.
 */
export const LogEvent = z.object({
  convId: ConvId,
  author: UserId,
  seq: z.number().int().min(1),
  hlc: Hlc,
  type: z.string().min(1).max(48),
  body: z.unknown(),
  sig: SignatureB64,
});
export type LogEvent = z.infer<typeof LogEvent>;

export const MAX_MESSAGE_TEXT = 28_000;

/** A message within a conversation, by its event ID `author:seq`. */
export const MsgRef = z.object({ author: UserId, seq: z.number().int().min(1) });
export type MsgRef = z.infer<typeof MsgRef>;

/**
 * Files are split into 1 MB chunks. The limit used to be 2 GB (plan section 10); it is now 4 TB,
 * which is as far as a chunk list that fits in memory on both PCs (32 bytes per MB) goes, and far
 * beyond any file an office moves. Older builds cannot read an offer above 2 GB.
 */
export const FILE_CHUNK_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
export const MAX_FILE_CHUNKS = MAX_FILE_BYTES / FILE_CHUNK_BYTES;

/**
 * The `manifest` of a file that was shared as it is, without being read first (0.9.0 and later).
 * Reading a whole file to fingerprint it before the first byte can go out took minutes for a big
 * file, and on a LAN it buys nothing: the link is TLS, so bytes cannot change in transit. Such a
 * file's `sha256` is not a hash but a random 256-bit id, there is no chunk list, and the receiver
 * fetches it from the sender only and checks its size. Older builds cannot receive these files
 * (they look for a chunk list that does not exist); they still read the message.
 */
export const UNHASHED_MANIFEST = '0'.repeat(64);

/**
 * A shared file, identified by its SHA-256 (or, when `manifest` is `UNHASHED_MANIFEST`, by a
 * random id). `manifest` is the SHA-256 of the concatenated per-chunk SHA-256 hashes, so a
 * receiver can verify every chunk from any holder.
 */
export const FileRef = z.object({
  sha256: Sha256Hex,
  name: z.string().min(1).max(255),
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  mime: z.string().max(127),
  manifest: Sha256Hex,
  /** Small JPEG preview for images, base64url. */
  thumb: Base64Url.max(48_000).optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
});
export type FileRef = z.infer<typeof FileRef>;

/** Title and summary of a LAN web page, fetched by the sender while composing. */
export const LinkPreview = z.object({
  url: z.string().max(2_048),
  title: z.string().max(300),
  description: z.string().max(500).optional(),
});
export type LinkPreview = z.infer<typeof LinkPreview>;

/** Fields shared by messages and file posts. Text is the restricted Markdown in docs/protocol.md. */
const MessageFields = {
  mentions: z.array(UserId).max(50).optional(),
  replyTo: MsgRef.optional(),
  urgent: z.boolean().optional(),
  /** In a channel: the root post this is a reply to (threads). */
  thread: MsgRef.optional(),
};

export const MsgPostBody = z.object({
  text: z.string().min(1).max(MAX_MESSAGE_TEXT),
  ...MessageFields,
  forwarded: z.object({ from: z.string().max(64), at: EpochMs }).optional(),
  preview: LinkPreview.optional(),
  /** A channel announcement: a root post with a headline. */
  announcement: z.object({ headline: z.string().min(1).max(120) }).optional(),
});
export type MsgPostBody = z.infer<typeof MsgPostBody>;

export const FileShareBody = z.object({
  file: FileRef,
  /** Optional caption. */
  text: z.string().max(MAX_MESSAGE_TEXT).optional(),
  ...MessageFields,
});
export type FileShareBody = z.infer<typeof FileShareBody>;

/** Valid only from the target's author; the highest HLC wins. */
export const MsgEditBody = z.object({
  target: MsgRef,
  text: z.string().min(1).max(MAX_MESSAGE_TEXT),
  mentions: z.array(UserId).max(50).optional(),
});
export const MsgDeleteBody = z.object({ target: MsgRef });
export const MsgReactBody = z.object({ target: MsgRef, emoji: z.string().min(1).max(32) });
export const MsgPinBody = z.object({ target: MsgRef });
/** The author has read everything up to this HLC (read receipts). */
export const MsgReadBody = z.object({ upto: Hlc });

// ---------------------------------------------------------------------------
// Groups, teams, channels
// ---------------------------------------------------------------------------

/**
 * A member as listed in membership events. Carrying the public key lets every member
 * verify posts by authors it has never met (the userId is the key's hash).
 */
export const Member = z.object({
  userId: UserId,
  spki: PublicKeyB64,
  name: z.string().trim().min(1).max(64),
  role: z.enum(['owner', 'member']).optional(),
});
export type Member = z.infer<typeof Member>;

export const MAX_MEMBERS = 250;
const Nonce = Base64Url.min(16).max(44);

/**
 * Genesis of an ad hoc group chat (seq 1 of its creator). The conversation ID is a hash
 * of the creator and this body, so nobody can forge who created it.
 */
export const GroupCreateBody = z.object({
  title: z.string().trim().max(100).optional(),
  members: z.array(Member).min(1).max(MAX_MEMBERS),
  nonce: Nonce,
});
export type GroupCreateBody = z.infer<typeof GroupCreateBody>;

/** Genesis of a team's control log; the creator is its first owner. */
export const TeamCreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  visibility: z.enum(['public', 'private']),
  members: z.array(Member).min(1).max(MAX_MEMBERS),
  /** The General channel, created with the team. */
  general: ConvId,
  nonce: Nonce,
});
export type TeamCreateBody = z.infer<typeof TeamCreateBody>;

/** Add members to a group, a team, or (with channelId) a private channel. */
export const MemberAddBody = z.object({
  members: z.array(Member).min(1).max(MAX_MEMBERS),
  channelId: ConvId.optional(),
});
export const MemberRemoveBody = z.object({ userId: UserId, channelId: ConvId.optional() });
export const MemberLeaveBody = z.object({ channelId: ConvId.optional() });
export const MemberRoleBody = z.object({ userId: UserId, role: z.enum(['owner', 'member']) });
/**
 * A group's name and/or picture. A rename carries `title`; a new picture carries `picture` (a small
 * JPEG, base64; empty text removes it). Builds that predate pictures need `title`, so they keep
 * a picture-only change out of view (an invalid body is stored but not applied).
 */
export const MAX_GROUP_PICTURE_CHARS = 40_000;
export const ConvRenameBody = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  picture: z.string().max(MAX_GROUP_PICTURE_CHARS).optional(),
});
export const TeamRenameBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

/** A channel's ID is a hash of its team, creator and nonce (see docs/protocol.md). */
export const ChannelCreateBody = z.object({
  channelId: ConvId,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).optional(),
  private: z.boolean(),
  /** Private channels: initial members besides the creator (must be team members). */
  members: z.array(UserId).max(MAX_MEMBERS).optional(),
  nonce: Nonce,
});
export const ChannelRenameBody = z.object({
  channelId: ConvId,
  name: z.string().trim().min(1).max(60),
});
export const ChannelArchiveBody = z.object({ channelId: ConvId, archived: z.boolean() });

/** Event types that change who may read and write, or a team's structure. */
export const MEMBERSHIP_EVENT_TYPES = new Set<string>([
  'group.create',
  'team.create',
  'member.add',
  'member.remove',
  'member.leave',
  'member.role',
  'conv.rename',
  'team.rename',
  'channel.create',
  'channel.rename',
  'channel.archive',
]);

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export const PollCreateBody = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
  multi: z.boolean().optional(),
  thread: MsgRef.optional(),
});
export type PollCreateBody = z.infer<typeof PollCreateBody>;
/** The latest vote per voter counts; an empty list withdraws the vote. */
export const PollVoteBody = z.object({
  target: MsgRef,
  choices: z.array(z.number().int().min(0).max(9)).max(10),
});
/** Only the poll's author may close it; votes after the close do not count. */
export const PollCloseBody = z.object({ target: MsgRef });

// ---------------------------------------------------------------------------
// Meetings (M5)
// ---------------------------------------------------------------------------

/** How a meeting repeats; occurrences step in local time from the first one. */
export const Recurrence = z.object({
  freq: z.enum(['none', 'daily', 'weekdays', 'weekly']),
  /** No occurrence starts at or after this time. */
  until: EpochMs.optional(),
});
export type Recurrence = z.infer<typeof Recurrence>;

/** At most a day long, so occurrences of a daily series never overlap. */
export const MAX_MEETING_MS = 24 * 60 * 60 * 1000;

const MeetingFields = {
  title: z.string().trim().min(1).max(200),
  /** First occurrence. */
  start: EpochMs,
  end: EpochMs,
  recurrence: Recurrence,
  notes: z.string().max(4_000).optional(),
};

/**
 * A scheduled meeting, posted to the conversation whose members are invited (a meeting
 * chat created for it, a group chat or a channel). It shows there as a card.
 */
export const MeetingScheduleBody = z.object(MeetingFields);
export type MeetingScheduleBody = z.infer<typeof MeetingScheduleBody>;
/** The organiser changes the meeting: the whole description is replaced (last change wins). */
export const MeetingUpdateBody = z.object({ target: MsgRef, ...MeetingFields });
/** The organiser cancels the whole series, or one occurrence (by its start). */
export const MeetingCancelBody = z.object({ target: MsgRef, occurrence: EpochMs.optional() });
export const MeetingRsvpBody = z.object({
  target: MsgRef,
  response: z.enum(['accepted', 'tentative', 'declined']),
});

const CallIdText = z.string().regex(/^[a-z2-7]{32}$/, 'invalid callId');
/** A call started in this conversation (Meet now, or a meeting being joined): others may join. */
export const CallStartedBody = z.object({
  callId: CallIdText,
  media: z.enum(['audio', 'video']),
  /** The scheduled meeting this call is for, if any. */
  meeting: MsgRef.optional(),
});
/** The call announced by `target` is over (posted by whoever was last in it). */
export const CallEndedBody = z.object({ target: MsgRef });

/** Body schemas for the event types implemented so far. */
export const EVENT_BODIES = {
  'msg.post': MsgPostBody,
  'msg.edit': MsgEditBody,
  'msg.delete': MsgDeleteBody,
  'msg.react': MsgReactBody,
  'msg.unreact': MsgReactBody,
  'msg.pin': MsgPinBody,
  'msg.unpin': MsgPinBody,
  'msg.read': MsgReadBody,
  'file.share': FileShareBody,
  'group.create': GroupCreateBody,
  'conv.rename': ConvRenameBody,
  'team.create': TeamCreateBody,
  'team.rename': TeamRenameBody,
  'member.add': MemberAddBody,
  'member.remove': MemberRemoveBody,
  'member.leave': MemberLeaveBody,
  'member.role': MemberRoleBody,
  'channel.create': ChannelCreateBody,
  'channel.rename': ChannelRenameBody,
  'channel.archive': ChannelArchiveBody,
  'poll.create': PollCreateBody,
  'poll.vote': PollVoteBody,
  'poll.close': PollCloseBody,
  'meeting.schedule': MeetingScheduleBody,
  'meeting.update': MeetingUpdateBody,
  'meeting.cancel': MeetingCancelBody,
  'meeting.rsvp': MeetingRsvpBody,
  'call.started': CallStartedBody,
  'call.ended': CallEndedBody,
} as const satisfies Partial<Record<EventType, z.ZodType>>;

/** Event types that act on another message (`body.target`). */
export const TARGETED_EVENT_TYPES = new Set<string>([
  'msg.edit',
  'msg.delete',
  'msg.react',
  'msg.unreact',
  'msg.pin',
  'msg.unpin',
  'poll.vote',
  'poll.close',
  'meeting.update',
  'meeting.cancel',
  'meeting.rsvp',
  'call.ended',
]);

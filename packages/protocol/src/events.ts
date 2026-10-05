import { z } from 'zod';
import { Base64Url, EpochMs, Sha256Hex, SignatureB64, UserId } from './common.ts';

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

/** Files are split into 1 MB chunks; 2 GB is the per-file limit (plan section 10). */
export const FILE_CHUNK_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_FILE_CHUNKS = MAX_FILE_BYTES / FILE_CHUNK_BYTES;

/**
 * A shared file, identified by its SHA-256. `manifest` is the SHA-256 of the concatenated
 * per-chunk SHA-256 hashes, so a receiver can verify every chunk from any holder.
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
};

export const MsgPostBody = z.object({
  text: z.string().min(1).max(MAX_MESSAGE_TEXT),
  ...MessageFields,
  forwarded: z.object({ from: z.string().max(64), at: EpochMs }).optional(),
  preview: LinkPreview.optional(),
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
} as const satisfies Partial<Record<EventType, z.ZodType>>;

/** Event types that act on another message (`body.target`). */
export const TARGETED_EVENT_TYPES = new Set<string>([
  'msg.edit',
  'msg.delete',
  'msg.react',
  'msg.unreact',
  'msg.pin',
  'msg.unpin',
]);

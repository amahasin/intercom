import { z } from 'zod';
import { SignatureB64, UserId } from './common.ts';

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

export const MsgPostBody = z.object({
  text: z.string().min(1).max(MAX_MESSAGE_TEXT),
});
export type MsgPostBody = z.infer<typeof MsgPostBody>;

/** Body schemas for the event types implemented so far. */
export const EVENT_BODIES = {
  'msg.post': MsgPostBody,
} as const satisfies Partial<Record<EventType, z.ZodType>>;

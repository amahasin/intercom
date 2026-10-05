import { z } from 'zod';
import { Base64Url, EpochMs, Sha256Hex, UserId } from './common.ts';
import { ConvId } from './events.ts';
import { MAX_AVATAR_BYTES } from './profile.ts';

/** TCP port and framing limits for the peer link (WebSocket over mutual TLS 1.3). */
export const MAX_TEXT_FRAME_BYTES = 256 * 1024;
/** Binary frames: 16-byte transfer ID + 8-byte big-endian offset, then chunk bytes. */
export const BINARY_FRAME_HEADER_BYTES = 24;

export const LINK_PING_INTERVAL_MS = 15_000;
export const LINK_IDLE_CLOSE_MS = 10 * 60_000;
export const LINK_RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;

/** Per-link abuse limits; exceeding one closes the link for `ABUSE_BAN_MS`. */
export const LINK_LIMITS = {
  textFramesPerSecond: 50,
  openFileTransfers: 64,
  eventsPerSyncReply: 2_000,
} as const;
export const ABUSE_BAN_MS = 60_000;

/** Every message type the protocol defines, by group. Bodies are added per milestone. */
export const WIRE_TYPES = [
  // Session
  'hello',
  'ping',
  'pong',
  'bye',
  // Profile
  'profile.get',
  'profile.data',
  'avatar.get',
  'avatar.data',
  // Sync
  'sync.summary',
  'sync.request',
  'sync.events',
  'event.push',
  'event.ack',
  // Ephemeral
  'typing',
  'presence.detail',
  // Files
  'file.offer',
  'file.request',
  'file.chunk',
  'file.have',
  'file.cancel',
  // Calls
  'call.invite',
  'call.ringing',
  'call.accept',
  'call.decline',
  'call.sdp',
  'call.ice',
  'call.hangup',
  'call.state',
  // Peers (M6)
  'peers.exchange',
  'envelope.store',
  'envelope.fetch',
] as const;
export type WireType = (typeof WIRE_TYPES)[number];

/**
 * One JSON envelope per text frame. `type` is a free string so a peer can receive types
 * from a newer version and ignore them instead of failing.
 */
export const WireEnvelope = z.object({
  v: z.number().int().min(1),
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(64),
  replyTo: z.string().min(1).max(64).optional(),
  body: z.unknown(),
});
export type WireEnvelope = z.infer<typeof WireEnvelope>;

/** Capability strings advertised in `hello`. A peer never sends a type the other did not advertise. */
export const CAPABILITIES = ['session.v1', 'profile.v1', 'sync.v1'] as const;
export const Capability = z.string().min(1).max(48);

/** The capability a peer must have advertised before it is sent a given type. */
export const WIRE_TYPE_CAPABILITY: Partial<Record<WireType, string>> = {
  hello: 'session.v1',
  ping: 'session.v1',
  pong: 'session.v1',
  bye: 'session.v1',
  'profile.get': 'profile.v1',
  'profile.data': 'profile.v1',
  'sync.summary': 'sync.v1',
  'sync.events': 'sync.v1',
  'event.push': 'sync.v1',
  'event.ack': 'sync.v1',
};

/** Path of the WebSocket endpoint on the peer link. */
export const LINK_PATH = '/officemesh/v1';

export const HelloBody = z.object({
  protocol: z.number().int().min(1),
  app: z.string().max(32),
  userId: UserId,
  caps: z.array(Capability).max(64),
});
export type HelloBody = z.infer<typeof HelloBody>;

export const PingBody = z.object({ ts: EpochMs });
export const PongBody = z.object({ ts: EpochMs });
export const ByeBody = z.object({ reason: z.string().max(128).optional() });

export const ProfileGetBody = z.object({ userId: UserId });
/** `profile` is verified over the raw record before it is parsed with `SignedProfile`. */
export const ProfileDataBody = z.object({ profile: z.record(z.string(), z.unknown()) });

/** Max events in one `sync.events` frame (also bounded by `MAX_TEXT_FRAME_BYTES`). */
export const SYNC_BATCH_EVENTS = 500;
export const MAX_SYNC_SUMMARY_CONVERSATIONS = 5_000;

/** Per conversation, the highest contiguous `seq` held for each author. */
export const SyncSummaryBody = z.object({
  convs: z
    .array(
      z.object({
        convId: ConvId,
        heads: z.record(UserId, z.number().int().nonnegative()),
      }),
    )
    .max(MAX_SYNC_SUMMARY_CONVERSATIONS),
});
export type SyncSummaryBody = z.infer<typeof SyncSummaryBody>;

/** Events are validated one by one, over their raw form, by the receiver. */
export const SyncEventsBody = z.object({
  events: z.array(z.unknown()).max(SYNC_BATCH_EVENTS),
  /** The sender stopped at its per-reply limit; send a fresh summary to pull the rest. */
  more: z.boolean().optional(),
});

export const EventPushBody = z.object({ event: z.unknown() });

/** The sender now holds every event by `author` in `convId` up to `upto`. */
export const EventAckBody = z.object({
  convId: ConvId,
  author: UserId,
  upto: z.number().int().nonnegative(),
});
export type EventAckBody = z.infer<typeof EventAckBody>;

export const AvatarGetBody = z.object({ userId: UserId, hash: Sha256Hex });
export const AvatarDataBody = z.object({
  hash: Sha256Hex,
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: Base64Url.max(Math.ceil((MAX_AVATAR_BYTES * 4) / 3)),
});

/** Body schemas for the wire types implemented so far. */
export const WIRE_BODIES = {
  hello: HelloBody,
  ping: PingBody,
  pong: PongBody,
  bye: ByeBody,
  'profile.get': ProfileGetBody,
  'profile.data': ProfileDataBody,
  'avatar.get': AvatarGetBody,
  'avatar.data': AvatarDataBody,
  'sync.summary': SyncSummaryBody,
  'sync.events': SyncEventsBody,
  'event.push': EventPushBody,
  'event.ack': EventAckBody,
} as const satisfies Partial<Record<WireType, z.ZodType>>;

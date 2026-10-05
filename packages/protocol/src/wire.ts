import { z } from 'zod';
import { Base64Url, EpochMs, Sha256Hex, UserId } from './common.ts';
import { MAX_AVATAR_BYTES, SignedProfile } from './profile.ts';

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
export const CAPABILITIES = ['session.v1', 'profile.v1'] as const;
export const Capability = z.string().min(1).max(48);

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
export const ProfileDataBody = z.object({ profile: SignedProfile });

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
} as const satisfies Partial<Record<WireType, z.ZodType>>;

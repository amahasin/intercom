import { z } from 'zod';
import { Base64Url, EpochMs, Sha256Hex, UserId } from './common.ts';
import { ConvId, FILE_CHUNK_BYTES, MAX_FILE_CHUNKS } from './events.ts';
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
  'file.manifest',
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
  // Teams (M3)
  'team.fetch',
  'team.data',
  'event.batch',
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
export const CAPABILITIES = [
  'session.v1',
  'profile.v1',
  'sync.v1',
  'typing.v1',
  'files.v1',
  'teams.v1',
] as const;
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
  'avatar.get': 'profile.v1',
  'avatar.data': 'profile.v1',
  typing: 'typing.v1',
  'file.have': 'files.v1',
  'file.manifest': 'files.v1',
  'file.request': 'files.v1',
  'file.cancel': 'files.v1',
  'team.fetch': 'teams.v1',
  'team.data': 'teams.v1',
  'event.batch': 'teams.v1',
};

/** Path of the WebSocket endpoint on the peer link. */
export const LINK_PATH = '/officemesh/v1';

export const HelloBody = z.object({
  protocol: z.number().int().min(1),
  app: z.string().max(32),
  userId: UserId,
  caps: z.array(Capability).max(64),
  /** Public teams this peer belongs to, so anyone can find and join them. */
  publicTeams: z
    .array(z.object({ teamId: ConvId, name: z.string().max(100) }))
    .max(50)
    .optional(),
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

/**
 * A live event. `sentTo` lists members the sender delivered it to directly, so a
 * receiver forwards it only to members not yet reached.
 */
export const EventPushBody = z.object({
  event: z.unknown(),
  sentTo: z.array(UserId).max(300).optional(),
});

/** Several live events in one frame, so a burst of posts stays within the frame-rate limit. */
export const EventBatchBody = z.object({
  pushes: z.array(EventPushBody).min(1).max(SYNC_BATCH_EVENTS),
});

/** A non-member asks a member for a public team's control log (to join it). */
export const TeamFetchBody = z.object({ teamId: ConvId });
export const TeamDataBody = z.object({
  teamId: ConvId,
  events: z.array(z.unknown()).max(SYNC_BATCH_EVENTS),
});

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

/** Binary frames carry one file chunk after the 24-byte header. */
export const MAX_BINARY_FRAME_BYTES = BINARY_FRAME_HEADER_BYTES + FILE_CHUNK_BYTES;
/** Chunks one request may ask for. */
export const MAX_CHUNKS_PER_REQUEST = 16;

export const TypingBody = z.object({ convId: ConvId });

/** Ask whether a peer holds a file; the reply (also `file.have`) says how much. */
export const FileHaveBody = z.object({
  sha256: Sha256Hex,
  have: z.enum(['all', 'partial', 'none']).optional(),
  /** Bitmap of held chunks (bit i = chunk i), base64url, when `have` is `partial`. */
  chunks: Base64Url.max(Math.ceil(MAX_FILE_CHUNKS / 6) + 4).optional(),
});
/** Ask for, or answer with, the per-chunk SHA-256 list (32 bytes each, base64url). */
export const FileManifestBody = z.object({
  sha256: Sha256Hex,
  hashes: Base64Url.max(Math.ceil((MAX_FILE_CHUNKS * 32 * 4) / 3) + 4).optional(),
});
/** Ask for chunks; each arrives as a binary frame, or is listed in a `file.cancel` reply. */
export const FileRequestBody = z.object({
  sha256: Sha256Hex,
  chunks: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(MAX_FILE_CHUNKS - 1),
    )
    .min(1)
    .max(MAX_CHUNKS_PER_REQUEST),
});
export const FileCancelBody = z.object({
  sha256: Sha256Hex,
  chunks: z.array(z.number().int().min(0)).max(MAX_CHUNKS_PER_REQUEST).optional(),
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
  typing: TypingBody,
  'file.have': FileHaveBody,
  'file.manifest': FileManifestBody,
  'file.request': FileRequestBody,
  'file.cancel': FileCancelBody,
  'team.fetch': TeamFetchBody,
  'team.data': TeamDataBody,
  'event.batch': EventBatchBody,
} as const satisfies Partial<Record<WireType, z.ZodType>>;

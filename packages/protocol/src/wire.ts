import { z } from 'zod';
import { MAX_BEACON_BYTES } from './beacon.ts';
import { Base64Url, EpochMs, PublicKeyB64, Sha256Hex, UserId } from './common.ts';
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
  /** Chunk requests are counted apart: a fast link asks for a lot (16 chunks, 16 MB, each). */
  fileRequestsPerSecond: 400,
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
  'envelope.ack',
  // Teams (M3)
  'team.fetch',
  'team.data',
  'event.batch',
  // Meetings (M5)
  'call.join',
  'call.reaction',
  'call.control',
  // Host relay (M6)
  'relay.request',
  'relay.response',
  'relay.notify',
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
  'calls.mesh',
  'calls.meet',
  'peers.v1',
  'envelopes.v1',
  'calls.relay',
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
  'call.invite': 'calls.mesh',
  'call.ringing': 'calls.mesh',
  'call.accept': 'calls.mesh',
  'call.decline': 'calls.mesh',
  'call.sdp': 'calls.mesh',
  'call.ice': 'calls.mesh',
  'call.hangup': 'calls.mesh',
  'call.state': 'calls.mesh',
  'call.join': 'calls.meet',
  'call.reaction': 'calls.meet',
  'call.control': 'calls.meet',
  'peers.exchange': 'peers.v1',
  'envelope.store': 'envelopes.v1',
  'envelope.fetch': 'envelopes.v1',
  'envelope.ack': 'envelopes.v1',
  'relay.request': 'calls.relay',
  'relay.response': 'calls.relay',
  'relay.notify': 'calls.relay',
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

// ---------------------------------------------------------------------------
// Calls (M4). Media flows directly between PCs over WebRTC; these carry signaling only.
// ---------------------------------------------------------------------------

/** Mesh call limits (plan section 9): video up to 8 people, audio-only up to 12. */
export const MAX_VIDEO_CALL_PARTICIPANTS = 8;
export const MAX_CALL_PARTICIPANTS = 12;
/** How long an invitation rings before it counts as missed. */
export const CALL_RING_MS = 30_000;

export const CallId = z.string().regex(/^[a-z2-7]{32}$/, 'invalid callId');
export const CallMedia = z.enum(['audio', 'video']);
export type CallMedia = z.infer<typeof CallMedia>;

/**
 * One participant's entry in the replicated call roster. Only its owner changes it, each
 * time raising `v`; a receiver keeps the entry with the higher `v`.
 */
export const CallParticipant = z.object({
  userId: UserId,
  joinedAt: EpochMs,
  muted: z.boolean(),
  video: z.boolean(),
  sharing: z.boolean(),
  onHold: z.boolean(),
  /** When this participant last started speaking (0 if never): drives active speaker. */
  lastSpokeAt: EpochMs,
  left: z.boolean(),
  v: z.number().int().nonnegative(),
  /** Meetings (M5): hand raised, recording locally; optional for M4 peers. */
  hand: z.boolean().optional(),
  recording: z.boolean().optional(),
  /** Set only on the organiser's entry: the participant everyone pins. */
  spotlight: UserId.nullable().optional(),
  /**
   * Host relay (M6): how well this PC can host a large meeting's media. 0 cannot host;
   * below `RELAY_CAPABLE_SCORE` it can host a capped meeting (25 people).
   */
  relay: z.number().int().nonnegative().max(1_000_000).optional(),
});
export type CallParticipant = z.infer<typeof CallParticipant>;

/** A call on host relay: who hosts its media, and which hand-over this is. */
export const RelayRef = z.object({
  host: UserId,
  /** Raised at every hand-over; the higher epoch wins. */
  epoch: z.number().int().min(1).max(1_000_000),
});
export type RelayRef = z.infer<typeof RelayRef>;

export const CallInviteBody = z.object({
  callId: CallId,
  /** The chat the call belongs to (a direct or group chat), if any. */
  convId: ConvId.optional(),
  media: CallMedia,
  /** Who started the call: they may mute everyone, remove people and spotlight. */
  organizer: UserId.optional(),
  /** A meeting: it stays open while anyone is in it, even alone. */
  meeting: z.boolean().optional(),
  /** The temporary chat of a call that has grown past two people (see `CallStateBody.chat`). */
  chat: ConvId.optional(),
  /** Everyone already in the call, so the callee knows who it will connect to. */
  participants: z.array(CallParticipant).max(MAX_CALL_PARTICIPANTS),
  /** On host relay (M6): the callee joins through the host, which sends the full roster. */
  relay: RelayRef.optional(),
});
export const CallIdBody = z.object({ callId: CallId });
export const CallAcceptBody = z.object({ callId: CallId, participant: CallParticipant });
export const CallDeclineReason = z.enum(['declined', 'busy', 'dnd', 'full', 'timeout']);
export type CallDeclineReason = z.infer<typeof CallDeclineReason>;
export const CallDeclineBody = z.object({ callId: CallId, reason: CallDeclineReason });

/**
 * An SDP offer or answer, signed by the sender's identity key. `fingerprint` repeats the
 * DTLS fingerprint from the SDP, so the encrypted media is bound to the signer (plan
 * section 9); the receiver checks both the signature and that they match.
 */
export const CallSdpBody = z.object({
  callId: CallId,
  from: UserId,
  to: UserId,
  type: z.enum(['offer', 'answer']),
  sdp: z.string().max(100_000),
  fingerprint: z.string().max(200),
  sig: z.string().max(200),
});
export type CallSdpBody = z.infer<typeof CallSdpBody>;

export const IceCandidate = z.object({
  candidate: z.string().max(1_000),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().nonnegative().max(64).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export type IceCandidate = z.infer<typeof IceCandidate>;
/** `candidate: null` marks the end of candidates. */
export const CallIceBody = z.object({ callId: CallId, candidate: IceCandidate.nullable() });
export const CallStateBody = z.object({
  callId: CallId,
  convId: ConvId.optional(),
  media: CallMedia,
  organizer: UserId.optional(),
  /**
   * The call's temporary chat: a group made when a call of two grows to three or more, with the
   * people in it. Everyone in the call shows it in the call window instead of the one-to-one
   * chat. Older builds ignore it.
   */
  chat: ConvId.optional(),
  participants: z.array(CallParticipant).max(MAX_CALL_PARTICIPANTS),
  /** The call moved to host relay (M6): connect to the host instead of to each other. */
  relay: RelayRef.optional(),
});
export type CallStateBody = z.infer<typeof CallStateBody>;

/** Ask a participant of a call announced in a conversation to let us in (they invite us). */
export const CallJoinBody = z.object({ callId: CallId, convId: ConvId });
/** A live reaction, shown briefly over the sender's tile. */
export const CALL_REACTIONS = ['👍', '❤️', '👏', '😂', '😮'] as const;
export const CallReactionBody = z.object({ callId: CallId, emoji: z.enum(CALL_REACTIONS) });
/** Organiser controls; others ignore them from anyone but the organiser. */
export const CallControlBody = z.object({
  callId: CallId,
  /** `end` ends the call for everyone (newer builds only; older builds ignore it). */
  action: z.enum(['mute', 'remove', 'spotlight', 'end']),
  /** Who is muted, removed or spotlit; for mute, absent means everyone. */
  target: UserId.nullable().optional(),
});
export type CallControlBody = z.infer<typeof CallControlBody>;

// ---------------------------------------------------------------------------
// Host relay (M6, plan section 9). Above the mesh limits one participant's PC forwards
// everyone's media with mediasoup: each person sends one stream up and receives a few.
// Signaling is a star through the host over the peer links; media is WebRTC to the host.
// ---------------------------------------------------------------------------

export const MAX_RELAY_PARTICIPANTS = 100;
/** With no relay-capable PC present, a relayed meeting is capped here. */
export const RELAY_CAPPED_PARTICIPANTS = 25;
/** Above this many people, newcomers join muted with their camera off. */
export const RELAY_JOIN_MUTED_ABOVE = 25;
/** Each person hears the loudest 3 and sees up to 9 cameras (the most recent speakers). */
export const RELAY_AUDIO_SPEAKERS = 3;
export const RELAY_VIDEO_TILES = 9;
/** A relay score at or above this marks a relay-capable PC (wired gigabit, 8+ cores). */
export const RELAY_CAPABLE_SCORE = 1_000;
/** UDP (and TCP fallback) ports of the host's media workers: one per worker, from here. */
export const RELAY_PORT_BASE = 47802;
export const RELAY_MAX_WORKERS = 16;
/** The host says it is alive this often; silence for `RELAY_HOST_TIMEOUT_MS` is a hand-over. */
export const RELAY_HEARTBEAT_MS = 2_000;
export const RELAY_HOST_TIMEOUT_MS = 6_000;

/** Bounded, loosely typed mediasoup parameter objects: mediasoup validates them in depth. */
const Json = z.record(z.string(), z.unknown());
const Params = (max: number) =>
  Json.refine((v) => JSON.stringify(v).length <= max, { message: 'parameters too large' });

export const RelaySource = z.enum(['mic', 'camera', 'screen']);
export type RelaySource = z.infer<typeof RelaySource>;

export const RELAY_REQUEST_DATA = {
  /** Enter the relayed call (or re-enter after a hand-over) with this roster entry. */
  join: z.object({ participant: CallParticipant }),
  leave: z.object({}),
  /** This participant's own roster entry changed. */
  update: z.object({ participant: CallParticipant }),
  capabilities: z.object({}),
  /** `plain` is plain RTP with SRTP, for simulated participants in load tests only. */
  createTransport: z.object({
    direction: z.enum(['send', 'recv']),
    kind: z.enum(['webrtc', 'plain']).default('webrtc'),
    /** Receiving side's capabilities (recv transports); consumers are created to match. */
    rtpCapabilities: Params(64_000).optional(),
  }),
  connectTransport: z.object({
    transportId: z.string().max(64),
    dtlsParameters: Params(4_000).optional(),
    /** Plain transports: where to send, and the SRTP keys. */
    ip: z.ipv4().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    srtpParameters: Params(1_000).optional(),
  }),
  produce: z.object({
    transportId: z.string().max(64),
    kind: z.enum(['audio', 'video']),
    source: RelaySource,
    rtpParameters: Params(16_000),
    paused: z.boolean().optional(),
  }),
  closeProducer: z.object({ source: RelaySource }),
  pauseProducer: z.object({ source: RelaySource, paused: z.boolean() }),
  /** Consumers the client has set up (one, or many at once after joining). */
  resumeConsumer: z.object({
    consumerId: z.string().max(64).optional(),
    consumerIds: z.array(z.string().max(64)).max(300).optional(),
  }),
  /** A live reaction, passed to everyone by the host. */
  react: z.object({ emoji: z.enum(CALL_REACTIONS) }),
  /** Organiser controls, passed to their targets by the host (only from the organiser). */
  control: z.object({
    action: z.enum(['mute', 'remove', 'end']),
    target: UserId.nullable().optional(),
  }),
  /** Which page of cameras to see (0: the most recent speakers), and at what size. */
  setView: z.object({
    page: z.number().int().min(0).max(20).optional(),
    layer: z.number().int().min(0).max(2).optional(),
  }),
} as const;
export type RelayMethod = keyof typeof RELAY_REQUEST_DATA;

export const RelayRequestBody = z.object({
  callId: CallId,
  epoch: z.number().int().min(1),
  method: z.enum(Object.keys(RELAY_REQUEST_DATA) as [RelayMethod, ...RelayMethod[]]),
  data: z.unknown(),
});
export type RelayRequestBody = z.infer<typeof RelayRequestBody>;

export const RelayResponseBody = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().max(300).optional(),
  /** Not (or no longer) the host: ask this one instead. */
  redirect: RelayRef.optional(),
});
export type RelayResponseBody = z.infer<typeof RelayResponseBody>;

export const RELAY_NOTIFY_DATA = {
  /** Roster entries that changed (`full`: the whole roster, after joining). */
  roster: z.object({
    participants: z.array(CallParticipant).max(MAX_RELAY_PARTICIPANTS),
    full: z.boolean().optional(),
    organizer: UserId.optional(),
  }),
  newConsumer: z.object({
    consumerId: z.string().max(64),
    producerId: z.string().max(64),
    userId: UserId,
    source: RelaySource,
    kind: z.enum(['audio', 'video']),
    rtpParameters: Params(16_000),
    paused: z.boolean(),
  }),
  consumerClosed: z.object({ consumerId: z.string().max(64) }),
  consumerPaused: z.object({ consumerId: z.string().max(64), paused: z.boolean() }),
  /** Stop or start sending a source nobody (or somebody again) receives. */
  producerPaused: z.object({ source: RelaySource, paused: z.boolean() }),
  /** The loudest speakers now, loudest first. */
  speakers: z.object({ userIds: z.array(UserId).max(RELAY_AUDIO_SPEAKERS) }),
  /** The host is alive; how many people its cameras order has (for paging). */
  heartbeat: z.object({ cameras: z.number().int().nonnegative() }),
  reaction: z.object({ userId: UserId, emoji: z.enum(CALL_REACTIONS) }),
  /** The organiser muted or removed this participant, or ended the meeting for everyone. */
  controlled: z.object({ action: z.enum(['mute', 'remove', 'end']) }),
  /**
   * Several notifications in one frame: joining brings a consumer for every voice and
   * camera at once, which as separate frames would trip the link's frame-rate limit.
   */
  batch: z.object({
    items: z
      .array(z.object({ method: z.string().max(32), data: z.unknown() }))
      .min(1)
      .max(300),
  }),
} as const;
export type RelayNotifyMethod = keyof typeof RELAY_NOTIFY_DATA;

export const RelayNotifyBody = z.object({
  callId: CallId,
  epoch: z.number().int().min(1),
  method: z.enum(Object.keys(RELAY_NOTIFY_DATA) as [RelayNotifyMethod, ...RelayNotifyMethod[]]),
  data: z.unknown(),
});
export type RelayNotifyBody = z.infer<typeof RelayNotifyBody>;

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
/** A chunk bitmap larger than this (about 1.2 million chunks) is not sent: it would not fit a frame. */
export const MAX_HAVE_BITMAP_BYTES = 150 * 1024;
/** Hashes in one `file.manifest` page: a big file's list is fetched a page at a time. */
export const MANIFEST_PAGE_CHUNKS = 2048;
/**
 * Ask for, or answer with, a page of the per-chunk SHA-256 list (32 bytes each, base64url).
 * `from` is the first chunk wanted (default 0); a reply holds at most MANIFEST_PAGE_CHUNKS
 * hashes starting there. A file of up to 2 GB is one page, as before.
 */
export const FileManifestBody = z.object({
  sha256: Sha256Hex,
  from: z.number().int().min(0).max(MAX_FILE_CHUNKS).optional(),
  hashes: Base64Url.max(Math.ceil((MANIFEST_PAGE_CHUNKS * 32 * 4) / 3) + 4).optional(),
});
/** Ask for chunks; each arrives as a binary frame, or is listed in a `file.cancel` reply. */
export const FileRequestBody = z.object({
  sha256: Sha256Hex,
  /**
   * Bytes of the file the requester already holds (M6.1), so the sender can show how far
   * along the transfer is. Older peers do not send it.
   */
  have: z.number().int().nonnegative().optional(),
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

// ---------------------------------------------------------------------------
// Other subnets (M6). Multicast does not cross routers: one colleague added by address
// shares the peers it knows, and remote peers keep each other fresh over the link.
// ---------------------------------------------------------------------------

/** Peers listed in one `peers.exchange`. */
export const MAX_EXCHANGED_PEERS = 500;
/** A remote peer's own beacon travels over the link this often instead of by multicast. */
export const REMOTE_KEEPALIVE_MS = 15_000;

export const KnownPeer = z.object({
  userId: UserId,
  /** SPKI of the peer's key; the receiver checks it hashes to `userId`, and TLS proves it. */
  pub: PublicKeyB64,
  address: z.ipv4(),
  port: z.number().int().min(1).max(65535),
});
export type KnownPeer = z.infer<typeof KnownPeer>;

export const PeersExchangeBody = z.object({
  /** Colleagues the sender sees online now, with the address it reaches them on. */
  peers: z.array(KnownPeer).max(MAX_EXCHANGED_PEERS),
  /** The sender's own signed beacon (its exact JSON text): presence and liveness. */
  beacon: z.string().max(MAX_BEACON_BYTES).optional(),
});
export type PeersExchangeBody = z.infer<typeof PeersExchangeBody>;

// ---------------------------------------------------------------------------
// Sealed envelopes (M6): a direct-chat event sealed to its recipient and left with up
// to 3 online colleagues, who cannot read it, for up to 7 days.
// ---------------------------------------------------------------------------

export const ENVELOPE_CARRIERS = 3;
export const ENVELOPE_TTL_MS = 7 * 24 * 60 * 60_000;
/** Other people's envelopes one PC holds, at most. */
export const ENVELOPE_STORE_BYTES = 50 * 1024 * 1024;
/** Sealed ciphertext of one envelope, at most (base64url characters). */
export const MAX_ENVELOPE_CT = 128 * 1024;
export const MAX_ENVELOPES_PER_FRAME = 16;

/**
 * Everything but `to` and `exp` is opaque to a carrier. `epk` is a one-time key, so the
 * envelope does not say who sent it; the author's identity is inside, with the event.
 */
export const SealedEnvelope = z.object({
  v: z.literal(1),
  to: UserId,
  exp: EpochMs,
  epk: PublicKeyB64,
  iv: Base64Url.length(16),
  ct: Base64Url.max(MAX_ENVELOPE_CT),
});
export type SealedEnvelope = z.infer<typeof SealedEnvelope>;

/** Inside an envelope: the signed event and its author's key. */
export const EnvelopeContent = z.object({
  event: z.record(z.string(), z.unknown()),
  pub: PublicKeyB64,
});

/** Hand envelopes to a carrier, or (from a carrier) to their recipient. */
export const EnvelopeStoreBody = z.object({
  envelopes: z.array(SealedEnvelope).min(1).max(MAX_ENVELOPES_PER_FRAME),
});
/** Ask a colleague for any envelopes it carries for us; they arrive as `envelope.store`. */
export const EnvelopeFetchBody = z.object({});
/**
 * The sender takes responsibility for these envelopes (by SHA-256 of the sealed parts):
 * a carrier has stored them, or their recipient has opened them.
 */
export const EnvelopeAckBody = z.object({
  ids: z.array(Sha256Hex).min(1).max(MAX_ENVELOPES_PER_FRAME),
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
  'call.invite': CallInviteBody,
  'call.ringing': CallIdBody,
  'call.accept': CallAcceptBody,
  'call.decline': CallDeclineBody,
  'call.sdp': CallSdpBody,
  'call.ice': CallIceBody,
  'call.hangup': CallIdBody,
  'call.state': CallStateBody,
  'call.join': CallJoinBody,
  'call.reaction': CallReactionBody,
  'call.control': CallControlBody,
  'peers.exchange': PeersExchangeBody,
  'envelope.store': EnvelopeStoreBody,
  'envelope.fetch': EnvelopeFetchBody,
  'envelope.ack': EnvelopeAckBody,
  'relay.request': RelayRequestBody,
  'relay.response': RelayResponseBody,
  'relay.notify': RelayNotifyBody,
} as const satisfies Partial<Record<WireType, z.ZodType>>;

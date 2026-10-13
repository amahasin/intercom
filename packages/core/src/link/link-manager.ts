import {
  ABUSE_BAN_MS,
  CAPABILITIES,
  HelloBody,
  LINK_IDLE_CLOSE_MS,
  LINK_LIMITS,
  LINK_PING_INTERVAL_MS,
  LINK_RECONNECT_BACKOFF_MS,
  MAX_BINARY_FRAME_BYTES,
  MAX_TEXT_FRAME_BYTES,
  PROTOCOL_VERSION,
  WIRE_BODIES,
  WIRE_TYPE_CAPABILITY,
  WireEnvelope,
  type WireType,
} from '@officemesh/protocol';
import type { Clock, Logger, PeerChannel, TimerHandle, Transport } from '../interfaces.ts';

const HELLO_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Two missed pongs, plus a little slack for a busy peer. */
const PONG_TIMEOUT_MS = 2 * LINK_PING_INTERVAL_MS + 2_000;
const SESSION_TYPES = new Set(['hello', 'ping', 'pong', 'bye']);

export interface Reply {
  type: string;
  body: unknown;
}

/** Handles one message type. Returning a Reply answers the request it came with. */
export type WireHandler = (
  from: string,
  body: unknown,
  envelope: WireEnvelope,
) => Reply | void | Promise<Reply | void>;

interface Link {
  userId: string;
  channel: PeerChannel;
  outbound: boolean;
  ready: boolean;
  caps: Set<string>;
  peerApp: string;
  publicTeams: Array<{ teamId: string; name: string }>;
  openedAt: number;
  lastActivity: number;
  lastPingSent: number;
  lastPong: number;
  frameWindowStart: number;
  frameCount: number;
  fileRequestCount: number;
  unsubscribe: Array<() => void>;
}

/** How a `file.request` frame starts: see `sendRaw`. */
const FILE_REQUEST_START = `{"v":${PROTOCOL_VERSION},"type":"file.request"`;

export interface LinkManagerOptions {
  selfId: string;
  appVersion: string;
  transport: Transport;
  clock: Clock;
  logger: Logger;
  caps?: readonly string[];
  /** Public teams to advertise in `hello`, so colleagues can discover and join them. */
  publicTeams?: () => Array<{ teamId: string; name: string }>;
}

/**
 * Owns every peer link: the `hello` handshake, one link per peer pair, keepalive, idle
 * close, abuse limits, reconnect backoff and request/response matching.
 */
export class LinkManager {
  private readonly opts: LinkManagerOptions;
  private readonly links = new Map<string, Link>();
  private readonly dials = new Map<string, Promise<boolean>>();
  private readonly failures = new Map<string, { count: number; nextAt: number }>();
  private readonly bans = new Map<string, number>();
  private readonly handlers = new Map<string, WireHandler>();
  private binaryHandler: ((from: string, data: Uint8Array) => void) | undefined;
  private readonly waiters = new Map<string, Set<(ok: boolean) => void>>();
  private readonly pongWaiters = new Map<string, Set<() => void>>();
  private readonly requests = new Map<
    string,
    { userId: string; resolve: (r: Reply) => void; reject: (e: Error) => void; timer: TimerHandle }
  >();
  private readonly upListeners = new Set<(userId: string) => void>();
  private readonly downListeners = new Set<(userId: string, reason: string) => void>();
  private readonly caps: readonly string[];
  private tick: TimerHandle | undefined;
  private nextId = 1;
  private stopped = false;
  port: number | null = null;

  constructor(options: LinkManagerOptions) {
    this.opts = options;
    this.caps = options.caps ?? CAPABILITIES;
  }

  async start(): Promise<number> {
    this.port = await this.opts.transport.listen((channel) => this.adopt(channel, false));
    this.tick = this.opts.clock.setInterval(() => this.onTick(), 1_000);
    return this.port;
  }

  on(type: WireType, handler: WireHandler): void {
    this.handlers.set(type, handler);
  }

  /** File chunks arrive as binary frames (only one consumer: the transfer manager). */
  onBinary(handler: (from: string, data: Uint8Array) => void): void {
    this.binaryHandler = handler;
  }

  /** Send a binary frame to a ready peer that advertised `files.v1`. */
  sendBinary(userId: string, data: Uint8Array): boolean {
    const link = this.links.get(userId);
    if (!link?.ready || !link.caps.has('files.v1') || data.length > MAX_BINARY_FRAME_BYTES)
      return false;
    link.lastActivity = this.opts.clock.now();
    link.channel.send(data);
    return true;
  }

  /** Whether a ready peer advertised a capability. */
  hasCap(userId: string, cap: string): boolean {
    return this.links.get(userId)?.caps.has(cap) === true;
  }

  onLinkUp(listener: (userId: string) => void): () => void {
    this.upListeners.add(listener);
    return () => this.upListeners.delete(listener);
  }

  onLinkDown(listener: (userId: string, reason: string) => void): () => void {
    this.downListeners.add(listener);
    return () => this.downListeners.delete(listener);
  }

  isReady(userId: string): boolean {
    return this.links.get(userId)?.ready === true;
  }

  /** Re-send `hello` on every ready link, after what it advertises has changed. */
  refreshHello(): void {
    for (const link of this.links.values()) {
      if (!link.ready) continue;
      this.sendRaw(link, 'hello', {
        protocol: PROTOCOL_VERSION,
        app: this.opts.appVersion.slice(0, 32),
        userId: this.opts.selfId,
        caps: [...this.caps],
        ...this.advertisedTeams(),
      });
    }
  }

  /** The public teams a ready peer advertised in its `hello`. */
  publicTeamsOf(userId: string): Array<{ teamId: string; name: string }> {
    const link = this.links.get(userId);
    return link?.ready ? link.publicTeams : [];
  }

  readyPeers(): string[] {
    return [...this.links.values()].filter((l) => l.ready).map((l) => l.userId);
  }

  peerApp(userId: string): string | undefined {
    return this.links.get(userId)?.peerApp;
  }

  /** The key the peer proved on its current link. */
  remoteSpki(userId: string): Buffer | undefined {
    return this.links.get(userId)?.channel.remoteSpki;
  }

  /** False while a peer is banned or inside its reconnect backoff. */
  canDial(userId: string): boolean {
    const now = this.opts.clock.now();
    if ((this.bans.get(userId) ?? 0) > now) return false;
    return (this.failures.get(userId)?.nextAt ?? 0) <= now;
  }

  /** Resolve true once a ready link to `userId` exists, dialing if needed. */
  ensureLink(userId: string, address: string, port: number): Promise<boolean> {
    if (this.stopped || userId === this.opts.selfId) return Promise.resolve(false);
    const link = this.links.get(userId);
    if (link?.ready) return Promise.resolve(true);
    if (link) return this.waitReady(userId, READY_TIMEOUT_MS);
    const inflight = this.dials.get(userId);
    if (inflight) return inflight;
    if (!this.canDial(userId)) return Promise.resolve(false);
    const p = this.dial(userId, address, port).finally(() => this.dials.delete(userId));
    this.dials.set(userId, p);
    return p;
  }

  private async dial(userId: string, address: string, port: number): Promise<boolean> {
    try {
      const channel = await this.opts.transport.dial({ address, port, expectedUserId: userId });
      if (this.stopped) {
        channel.close('stopping');
        return false;
      }
      this.adopt(channel, true);
    } catch (err) {
      this.recordFailure(userId);
      this.opts.logger.debug('dial failed', { peer: userId, address, port, err: String(err) });
      if (!this.links.has(userId)) return false;
    }
    const ok = await this.waitReady(userId, READY_TIMEOUT_MS);
    if (!ok) this.recordFailure(userId);
    return ok;
  }

  /**
   * Dial an address typed by a person (a colleague on another subnet): accept whoever
   * answers, and resolve with their userId once the link is ready.
   */
  async dialAddress(address: string, port: number): Promise<string | undefined> {
    if (this.stopped) return undefined;
    let channel: PeerChannel;
    try {
      channel = await this.opts.transport.dial({ address, port });
    } catch (err) {
      this.opts.logger.debug('dial by address failed', { address, port, err: String(err) });
      return undefined;
    }
    const userId = channel.remoteUserId;
    if (this.stopped || userId === this.opts.selfId) {
      channel.close(userId === this.opts.selfId ? 'that is this PC' : 'stopping');
      return undefined;
    }
    this.adopt(channel, true);
    return (await this.waitReady(userId, READY_TIMEOUT_MS)) ? userId : undefined;
  }

  private recordFailure(userId: string): void {
    const prev = this.failures.get(userId)?.count ?? 0;
    const delay = LINK_RECONNECT_BACKOFF_MS[Math.min(prev, LINK_RECONNECT_BACKOFF_MS.length - 1)]!;
    this.failures.set(userId, { count: prev + 1, nextAt: this.opts.clock.now() + delay });
  }

  private waitReady(userId: string, timeoutMs: number): Promise<boolean> {
    if (this.isReady(userId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let set = this.waiters.get(userId);
      if (!set) this.waiters.set(userId, (set = new Set()));
      const done = (ok: boolean) => {
        this.opts.clock.clearTimeout(timer);
        set.delete(done);
        resolve(ok);
      };
      const timer = this.opts.clock.setTimeout(() => done(false), timeoutMs);
      set.add(done);
    });
  }

  private settleWaiters(userId: string, ok: boolean): void {
    for (const w of [...(this.waiters.get(userId) ?? [])]) w(ok);
  }

  /**
   * Take ownership of an authenticated channel. If two peers dialed each other at once,
   * both sides keep the link dialed by the lower userId.
   */
  private adopt(channel: PeerChannel, outbound: boolean): void {
    const userId = channel.remoteUserId;
    const now = this.opts.clock.now();
    if (this.stopped || userId === this.opts.selfId || (this.bans.get(userId) ?? 0) > now) {
      channel.close('refused');
      return;
    }
    const existing = this.links.get(userId);
    if (existing) {
      const lower = this.opts.selfId < userId ? this.opts.selfId : userId;
      const dialer = (l: { outbound: boolean }) => (l.outbound ? this.opts.selfId : userId);
      const existingWins = dialer(existing) === lower && dialer({ outbound }) !== lower;
      if (existingWins) {
        channel.close('duplicate');
        return;
      }
      this.drop(existing, 'duplicate', false);
    }

    const link: Link = {
      userId,
      channel,
      outbound,
      ready: false,
      caps: new Set(),
      peerApp: '',
      publicTeams: [],
      openedAt: now,
      lastActivity: now,
      lastPingSent: now,
      lastPong: now,
      frameWindowStart: now,
      frameCount: 0,
      fileRequestCount: 0,
      unsubscribe: [],
    };
    this.links.set(userId, link);
    link.unsubscribe.push(
      channel.onMessage((data) => this.onFrame(link, data)),
      channel.onClose((reason) => {
        if (this.links.get(userId) === link) this.drop(link, reason, true);
      }),
    );
    this.sendRaw(link, 'hello', {
      protocol: PROTOCOL_VERSION,
      app: this.opts.appVersion.slice(0, 32),
      userId: this.opts.selfId,
      caps: [...this.caps],
      ...this.advertisedTeams(),
    });
  }

  private advertisedTeams(): { publicTeams?: Array<{ teamId: string; name: string }> } {
    try {
      const teams = this.opts.publicTeams?.() ?? [];
      return teams.length ? { publicTeams: teams } : {};
    } catch {
      return {};
    }
  }

  /** Forget a link. `notify` is false when it is being replaced by a newer one. */
  private drop(link: Link, reason: string, notify: boolean): void {
    for (const off of link.unsubscribe) off();
    if (this.links.get(link.userId) === link) this.links.delete(link.userId);
    link.channel.close(reason);
    for (const [id, req] of this.requests) {
      if (req.userId !== link.userId || this.links.has(link.userId)) continue;
      this.opts.clock.clearTimeout(req.timer);
      this.requests.delete(id);
      req.reject(new Error(`link closed: ${reason}`));
    }
    if (notify && link.ready) for (const l of this.downListeners) l(link.userId, reason);
    if (notify) this.settleWaiters(link.userId, false);
  }

  private onFrame(link: Link, data: string | Uint8Array): void {
    const now = this.opts.clock.now();
    if (typeof data !== 'string') {
      // Binary frames carry file chunks the receiver asked for; it checks each one.
      if (!link.ready || data.length > MAX_BINARY_FRAME_BYTES) {
        this.ban(link, 'unexpected binary frame');
        return;
      }
      link.lastActivity = now;
      this.binaryHandler?.(link.userId, data);
      return;
    }
    if (now - link.frameWindowStart >= 1_000) {
      link.frameWindowStart = now;
      link.frameCount = 0;
      link.fileRequestCount = 0;
    }
    // A request for file chunks is what a fast download is made of: it has a budget of its own
    // (the envelope is written with its type second, so the start of the text says what it is).
    const chunkRequest = data.startsWith(FILE_REQUEST_START);
    if (
      chunkRequest
        ? ++link.fileRequestCount > LINK_LIMITS.fileRequestsPerSecond
        : ++link.frameCount > LINK_LIMITS.textFramesPerSecond
    ) {
      this.ban(link, 'rate limit exceeded');
      return;
    }
    if (data.length > MAX_TEXT_FRAME_BYTES) {
      this.ban(link, 'frame too large');
      return;
    }
    let envelope: WireEnvelope;
    try {
      const parsed = WireEnvelope.safeParse(JSON.parse(data));
      if (!parsed.success) throw new Error('bad envelope');
      envelope = parsed.data;
    } catch {
      this.drop(link, 'malformed frame', true);
      return;
    }

    if (!link.ready) {
      this.onHello(link, envelope);
      return;
    }
    if (!SESSION_TYPES.has(envelope.type)) link.lastActivity = now;

    switch (envelope.type) {
      case 'hello': {
        // A repeated hello refreshes what the peer advertises (its public teams).
        const hello = HelloBody.safeParse(envelope.body);
        if (hello.success && hello.data.userId === link.userId)
          link.publicTeams = hello.data.publicTeams ?? [];
        return;
      }
      case 'ping':
        this.sendRaw(link, 'pong', { ts: now }, envelope.id);
        return;
      case 'pong':
        link.lastPong = now;
        for (const w of [...(this.pongWaiters.get(link.userId) ?? [])]) w();
        return;
      case 'bye':
        this.drop(link, 'peer said bye', true);
        return;
    }

    if (envelope.replyTo) {
      const req = this.requests.get(envelope.replyTo);
      if (req && req.userId === link.userId) {
        this.requests.delete(envelope.replyTo);
        this.opts.clock.clearTimeout(req.timer);
        req.resolve({ type: envelope.type, body: envelope.body });
        return;
      }
    }

    const handler = this.handlers.get(envelope.type);
    if (!handler) return; // Unknown types are ignored, not fatal.
    const schema = (WIRE_BODIES as Record<string, { safeParse(v: unknown): { success: boolean } }>)[
      envelope.type
    ];
    if (schema && !schema.safeParse(envelope.body).success) {
      this.opts.logger.warn('dropped invalid message', { peer: link.userId, type: envelope.type });
      return;
    }
    void (async () => {
      try {
        const reply = await handler(link.userId, envelope.body, envelope);
        if (reply) this.send(link.userId, reply.type as WireType, reply.body, envelope.id);
      } catch (err) {
        this.opts.logger.warn('handler failed', {
          peer: link.userId,
          type: envelope.type,
          err: String(err),
        });
      }
    })();
  }

  private onHello(link: Link, envelope: WireEnvelope): void {
    const hello = envelope.type === 'hello' ? HelloBody.safeParse(envelope.body) : undefined;
    if (!hello?.success) {
      this.drop(link, 'expected hello', true);
      return;
    }
    if (hello.data.userId !== link.userId) {
      this.opts.logger.warn('hello identity does not match certificate', { cert: link.userId });
      this.drop(link, 'identity mismatch', true);
      return;
    }
    link.ready = true;
    link.caps = new Set(hello.data.caps);
    link.peerApp = hello.data.app;
    link.publicTeams = hello.data.publicTeams ?? [];
    link.lastPong = this.opts.clock.now();
    this.failures.delete(link.userId);
    this.settleWaiters(link.userId, true);
    for (const l of this.upListeners) l(link.userId);
  }

  private ban(link: Link, reason: string): void {
    this.opts.logger.warn('closing abusive link', { peer: link.userId, reason });
    this.bans.set(link.userId, this.opts.clock.now() + ABUSE_BAN_MS);
    this.drop(link, reason, true);
  }

  private sendRaw(link: Link, type: string, body: unknown, replyTo?: string): string {
    const id = `${this.nextId++}`;
    const text = JSON.stringify({
      v: PROTOCOL_VERSION,
      type,
      id,
      ...(replyTo && { replyTo }),
      body,
    });
    if (Buffer.byteLength(text) > MAX_TEXT_FRAME_BYTES)
      throw new Error(`${type} frame exceeds ${MAX_TEXT_FRAME_BYTES} bytes`);
    link.channel.send(text);
    return id;
  }

  /** Send to a ready peer that advertised the type's capability. Returns the message id. */
  send(userId: string, type: WireType, body: unknown, replyTo?: string): string | undefined {
    const link = this.links.get(userId);
    if (!link?.ready) return undefined;
    const cap = WIRE_TYPE_CAPABILITY[type];
    if (cap && !link.caps.has(cap)) return undefined;
    if (!SESSION_TYPES.has(type)) link.lastActivity = this.opts.clock.now();
    return this.sendRaw(link, type, body, replyTo);
  }

  request(
    userId: string,
    type: WireType,
    body: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const id = this.send(userId, type, body);
      if (!id) {
        reject(new Error(`no ready link to ${userId} for ${type}`));
        return;
      }
      const timer = this.opts.clock.setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`${type} to ${userId} timed out`));
      }, timeoutMs);
      this.requests.set(id, { userId, resolve, reject, timer });
    });
  }

  /** Ping a peer now; true if any pong arrives within `timeoutMs`. */
  probe(userId: string, timeoutMs: number): Promise<boolean> {
    if (!this.send(userId, 'ping', { ts: this.opts.clock.now() })) return Promise.resolve(false);
    return new Promise((resolve) => {
      let set = this.pongWaiters.get(userId);
      if (!set) this.pongWaiters.set(userId, (set = new Set()));
      const done = (ok: boolean) => {
        this.opts.clock.clearTimeout(timer);
        set.delete(onPong);
        resolve(ok);
      };
      const onPong = () => done(true);
      const timer = this.opts.clock.setTimeout(() => done(false), timeoutMs);
      set.add(onPong);
    });
  }

  disconnect(userId: string, reason: string): void {
    const link = this.links.get(userId);
    if (!link) return;
    if (link.ready) this.send(userId, 'bye', { reason });
    this.drop(link, reason, true);
  }

  private onTick(): void {
    const now = this.opts.clock.now();
    for (const link of [...this.links.values()]) {
      if (!link.ready) {
        if (now - link.openedAt > HELLO_TIMEOUT_MS) this.drop(link, 'hello timeout', true);
        continue;
      }
      if (now - link.lastPong > PONG_TIMEOUT_MS) {
        this.drop(link, 'ping timeout', true);
      } else if (now - link.lastActivity > LINK_IDLE_CLOSE_MS) {
        this.disconnect(link.userId, 'idle');
      } else if (now - link.lastPingSent >= LINK_PING_INTERVAL_MS) {
        link.lastPingSent = now;
        this.sendRaw(link, 'ping', { ts: now });
      }
    }
    for (const [userId, until] of this.bans) if (until <= now) this.bans.delete(userId);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tick) this.opts.clock.clearInterval(this.tick);
    for (const link of [...this.links.values()]) {
      if (link.ready) this.sendRaw(link, 'bye', { reason: 'quitting' });
      this.drop(link, 'quitting', true);
    }
    for (const [id, req] of this.requests) {
      this.opts.clock.clearTimeout(req.timer);
      this.requests.delete(id);
      req.reject(new Error('stopping'));
    }
    await this.opts.transport.close();
  }
}

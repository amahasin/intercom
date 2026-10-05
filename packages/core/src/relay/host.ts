/**
 * The media relay a participant's PC runs for a large meeting (plan section 9, M6). Each
 * person sends one stream up and receives a few: the 3 loudest voices, up to 9 cameras
 * (the most recent speakers, at 180p or 360p from three simulcast layers) and the shared
 * screen. A camera nobody receives is paused at its sender. One mediasoup worker per core
 * (added as the meeting grows), with producers piped between their routers.
 *
 * The relay also holds the call's roster: participants send it their own entry, and it
 * tells everyone what changed. It speaks plain objects; the call manager carries them over
 * the peer links (or straight to this PC's own renderer).
 */
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import * as mediasoup from 'mediasoup';
import type { types as ms } from 'mediasoup';
import type { z } from 'zod';
import {
  RELAY_AUDIO_SPEAKERS,
  RELAY_HEARTBEAT_MS,
  RELAY_PORT_BASE,
  RELAY_REQUEST_DATA,
  RELAY_VIDEO_TILES,
  type CallParticipant,
  type RelayMethod,
  type RelayNotifyMethod,
  type RelaySource,
} from '@officemesh/protocol';
import type { Logger } from '../interfaces.ts';

/** Participants per router before another worker is started. */
const PER_ROUTER = 12;
/** Returning participants (after a hand-over) who do not rejoin within this are dropped. */
const REJOIN_GRACE_MS = 10_000;
const STATS_MS = 2_000;
const SPEAKERS_NOTIFY_MS = 500;

export const MEDIA_CODECS: ms.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48_000,
    channels: 2,
    preferredPayloadType: 100,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90_000,
    preferredPayloadType: 101,
    parameters: { 'x-google-start-bitrate': 300 },
  },
];

export interface RelayHostOptions {
  callId: string;
  epoch: number;
  /** Addresses participants reach this PC on (its LAN IPv4 addresses). */
  listenIps: string[];
  maxWorkers: number;
  /** Most participants this host takes. */
  maxParticipants: number;
  workerBin?: string | undefined;
  /** Plain-RTP transports for simulated participants (load tests only). */
  allowPlain?: boolean;
  logger: Logger;
  /** May this colleague join? (Invited, a member of the meeting's chat, or in the roster.) */
  mayJoin(userId: string): boolean;
  notify(userId: string, method: RelayNotifyMethod, data: unknown): void;
}

interface Slot {
  worker: ms.Worker;
  router: ms.Router;
  server: ms.WebRtcServer;
  members: number;
}

interface Member {
  userId: string;
  entry: CallParticipant;
  slot: Slot;
  transports: Map<string, ms.Transport>;
  recv: ms.Transport | undefined;
  rtpCapabilities: ms.RtpCapabilities | undefined;
  producers: Map<RelaySource, ms.Producer>;
  /** Owner paused (camera off, muted). */
  ownerPaused: Set<RelaySource>;
  /** By producer id. */
  consumers: Map<string, ms.Consumer>;
  /** Consumers the client has set up and asked to resume. */
  ready: Set<string>;
  page: number;
  layer: number | undefined;
  /** The last time this member was among the loudest. */
  lastSpokeAt: number;
  joinedAt: number;
  /** Seeded from the previous host's roster: dropped unless they rejoin in time. */
  pendingUntil: number | undefined;
  /** Consumer changes for this member run one at a time. */
  queue: Promise<void>;
}

export interface RelayStats {
  participants: number;
  workers: number;
  /** CPU of the relay (workers and this process) as a share of the whole PC, last interval. */
  cpuPercent: number;
  /** Worker CPU in ms since start (for load tests). */
  workerCpuMs: number;
  sendMbps: number;
  recvMbps: number;
  consumers: number;
  producers: number;
}

/** Group notifications into frames: alone as themselves, or batches under 200 KB. */
export function relayFrames(
  items: Array<{ method: string; data: unknown }>,
): Array<{ method: string; data: unknown }> {
  if (items.length === 1) return items;
  const frames: Array<{ method: string; data: unknown }> = [];
  let batch: Array<{ method: string; data: unknown }> = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length === 1) frames.push(batch[0]!);
    else if (batch.length > 1) frames.push({ method: 'batch', data: { items: batch } });
    batch = [];
    bytes = 0;
  };
  for (const item of items) {
    const size = JSON.stringify(item.data ?? null).length + 40;
    if (batch.length >= 300 || bytes + size > 200_000) flush();
    batch.push(item);
    bytes += size;
  }
  flush();
  return frames;
}

export class RelayHost {
  readonly o: RelayHostOptions;
  private readonly slots: Slot[] = [];
  private readonly members = new Map<string, Member>();
  /** Every entry this host knows, including people who left (for versioned merges). */
  private readonly roster = new Map<string, CallParticipant>();
  private readonly piped = new Map<string, Promise<void>>();
  private observer: ms.AudioLevelObserver | undefined;
  private speakers: string[] = [];
  private lastSpeakersNotify = 0;
  private speakersTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private starting: Promise<Slot> | undefined;
  private closed = false;
  private lastCpu = { at: performance.now(), workerMs: 0, procUs: 0 };
  private lastBytes = { at: performance.now(), sent: 0, recv: 0 };
  private current: RelayStats = {
    participants: 0,
    workers: 0,
    cpuPercent: 0,
    workerCpuMs: 0,
    sendMbps: 0,
    recvMbps: 0,
    consumers: 0,
    producers: 0,
  };
  organizer: string | undefined;

  constructor(options: RelayHostOptions) {
    this.o = options;
  }

  get callId(): string {
    return this.o.callId;
  }

  get epoch(): number {
    return this.o.epoch;
  }

  /** Start the first worker; resolves once the relay can take participants. */
  async start(): Promise<void> {
    await this.addSlot();
    this.heartbeat = setInterval(() => {
      const cameras = this.cameraOrder().length;
      for (const userId of this.members.keys()) this.o.notify(userId, 'heartbeat', { cameras });
      this.dropStale();
    }, RELAY_HEARTBEAT_MS);
    this.statsTimer = setInterval(() => void this.sample(), STATS_MS);
  }

  /** The roster of the previous host: these people are expected back after a hand-over. */
  seed(entries: CallParticipant[], now: number): void {
    for (const e of entries) {
      if (e.left) continue;
      const prev = this.roster.get(e.userId);
      if (!prev || prev.v < e.v) this.roster.set(e.userId, e);
      this.pendingSeeds.set(e.userId, now + REJOIN_GRACE_MS);
    }
  }

  private readonly pendingSeeds = new Map<string, number>();

  private dropStale(): void {
    const now = Date.now();
    const gone: CallParticipant[] = [];
    for (const [userId, until] of this.pendingSeeds) {
      if (until > now || this.members.has(userId)) {
        if (this.members.has(userId)) this.pendingSeeds.delete(userId);
        continue;
      }
      this.pendingSeeds.delete(userId);
      const e = this.roster.get(userId);
      if (e && !e.left) {
        const left = { ...e, left: true, v: e.v + 1 };
        this.roster.set(userId, left);
        gone.push(left);
      }
    }
    if (gone.length) this.broadcastRoster(gone);
  }

  // -------------------------------------------------------------------------
  // Workers
  // -------------------------------------------------------------------------

  private async addSlot(): Promise<Slot> {
    const index = this.slots.length;
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      ...(this.o.workerBin && { workerBin: this.o.workerBin }),
      rtcMinPort: 40_000,
      rtcMaxPort: 49_999,
    });
    worker.on('died', (err) => {
      this.o.logger.error('relay worker died', { err: String(err) });
    });
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const listen = (port: number | undefined): ms.TransportListenInfo[] =>
      this.o.listenIps.flatMap((ip) => [
        { protocol: 'udp' as const, ip, ...(port !== undefined && { port }) },
        { protocol: 'tcp' as const, ip, ...(port !== undefined && { port }) },
      ]);
    let server: ms.WebRtcServer;
    try {
      // One fixed port per worker, so the firewall needs one rule (47802 and up).
      server = await worker.createWebRtcServer({ listenInfos: listen(RELAY_PORT_BASE + index) });
    } catch (err) {
      this.o.logger.warn('relay port in use; using a random port', {
        port: RELAY_PORT_BASE + index,
        err: String(err),
      });
      server = await worker.createWebRtcServer({
        listenInfos: listen(undefined).map((l) => ({
          ...l,
          portRange: { min: 40_000, max: 49_999 },
        })),
      });
    }
    const slot: Slot = { worker, router, server, members: 0 };
    this.slots.push(slot);
    if (index === 0) {
      this.observer = await router.createAudioLevelObserver({
        maxEntries: RELAY_AUDIO_SPEAKERS,
        threshold: -65,
        interval: 300,
      });
      this.observer.on('volumes', (volumes) =>
        this.onSpeakers(volumes.map((v) => (v.producer.appData as { userId: string }).userId)),
      );
    }
    return slot;
  }

  /** The router with the fewest people; a new worker once all are full. */
  private async slotForNewMember(): Promise<Slot> {
    const least = [...this.slots].sort((a, b) => a.members - b.members)[0];
    if (least && (least.members < PER_ROUTER || this.slots.length >= this.o.maxWorkers))
      return least;
    this.starting ??= this.addSlot().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Make a producer available on another router (same id there). */
  private pipe(producer: ms.Producer, from: Slot, to: Slot): Promise<void> {
    if (from === to) return Promise.resolve();
    const key = `${producer.id}:${this.slots.indexOf(to)}`;
    let p = this.piped.get(key);
    if (!p) {
      p = from.router
        .pipeToRouter({ producerId: producer.id, router: to.router })
        .then(() => {})
        .catch((err: unknown) => {
          this.piped.delete(key);
          throw err;
        });
      this.piped.set(key, p);
    }
    return p;
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  async handle(from: string, method: RelayMethod, raw: unknown): Promise<unknown> {
    const started = performance.now();
    try {
      return await this.handleInner(from, method, raw);
    } finally {
      const ms = performance.now() - started;
      if (ms > 1_000) this.o.logger.warn('slow relay request', { method, ms: Math.round(ms) });
    }
  }

  private async handleInner(from: string, method: RelayMethod, raw: unknown): Promise<unknown> {
    if (this.closed) throw new Error('the relay has stopped');
    const schema = RELAY_REQUEST_DATA[method];
    const data = schema.parse(raw ?? {});
    if (method === 'join')
      return this.join(from, (data as { participant: CallParticipant }).participant);
    const m = this.members.get(from);
    if (!m) throw new Error('not in this meeting');
    switch (method) {
      case 'leave':
        this.leave(from);
        return {};
      case 'update':
        this.update(m, (data as { participant: CallParticipant }).participant);
        return {};
      case 'capabilities':
        return { rtpCapabilities: m.slot.router.rtpCapabilities };
      case 'createTransport':
        return this.createTransport(
          m,
          data as z.infer<(typeof RELAY_REQUEST_DATA)['createTransport']>,
        );
      case 'connectTransport':
        return this.connectTransport(
          m,
          data as z.infer<(typeof RELAY_REQUEST_DATA)['connectTransport']>,
        );
      case 'produce':
        return this.produce(m, data as z.infer<(typeof RELAY_REQUEST_DATA)['produce']>);
      case 'closeProducer': {
        const { source } = data as { source: RelaySource };
        m.producers.get(source)?.close();
        m.producers.delete(source);
        m.ownerPaused.delete(source);
        this.scheduleRefresh();
        return {};
      }
      case 'pauseProducer': {
        const { source, paused } = data as { source: RelaySource; paused: boolean };
        if (paused) m.ownerPaused.add(source);
        else m.ownerPaused.delete(source);
        await this.applyProducerPause(m, source);
        this.scheduleRefresh();
        return {};
      }
      case 'resumeConsumer': {
        const d = data as { consumerId?: string; consumerIds?: string[] };
        const ids = new Set([...(d.consumerIds ?? []), ...(d.consumerId ? [d.consumerId] : [])]);
        const want = this.wanted(m);
        for (const consumer of m.consumers.values()) {
          if (!ids.has(consumer.id)) continue;
          m.ready.add(consumer.id);
          if (want.get(consumer.producerId)) await consumer.resume();
        }
        return {};
      }
      case 'react': {
        const { emoji } = data as { emoji: string };
        for (const userId of this.members.keys())
          this.o.notify(userId, 'reaction', { userId: from, emoji });
        return {};
      }
      case 'control': {
        const { action, target } = data as { action: 'mute' | 'remove'; target?: string | null };
        if (from !== this.organizer) throw new Error('only the organiser can do that');
        const targets = target ? [target] : [...this.members.keys()].filter((u) => u !== from);
        for (const userId of targets) {
          if (!this.members.has(userId)) continue;
          this.o.notify(userId, 'controlled', { action });
          if (action === 'remove') this.leave(userId);
        }
        return {};
      }
      case 'setView': {
        const { page, layer } = data as { page?: number; layer?: number };
        if (page !== undefined) m.page = page;
        if (layer !== undefined) m.layer = layer;
        this.enqueue(m, () => this.refreshMember(m));
        return {};
      }
    }
    return {};
  }

  private async join(userId: string, entry: CallParticipant) {
    if (entry.userId !== userId) throw new Error('that is not you');
    const existing = this.members.get(userId);
    if (!existing) {
      if (!this.o.mayJoin(userId) && !this.roster.has(userId))
        throw new Error('not invited to this meeting');
      const present = [...this.members.keys()].length;
      if (present >= this.o.maxParticipants) throw new Error('full');
    }
    if (existing) {
      // Back after a link blip: same media connection, just a fresh roster entry and snapshot.
      const prev = this.roster.get(userId);
      if (!prev || prev.v < entry.v) {
        const next = { ...entry, left: false };
        this.roster.set(userId, next);
        existing.entry = next;
        this.broadcastRoster([next], userId);
      }
      return {
        participants: [...this.roster.values()],
        ...(this.organizer && { organizer: this.organizer }),
        max: this.o.maxParticipants,
        rtpCapabilities: existing.slot.router.rtpCapabilities,
      };
    }
    const slot = await this.slotForNewMember();
    slot.members++;
    const prev = this.roster.get(userId);
    const fresh: CallParticipant = {
      ...entry,
      left: false,
      v: Math.max(entry.v, (prev?.v ?? 0) + 1),
    };
    this.roster.set(userId, fresh);
    this.pendingSeeds.delete(userId);
    this.members.set(userId, {
      userId,
      entry: fresh,
      slot,
      transports: new Map(),
      recv: undefined,
      rtpCapabilities: undefined,
      producers: new Map(),
      ownerPaused: new Set(),
      consumers: new Map(),
      ready: new Set(),
      page: 0,
      layer: undefined,
      lastSpokeAt: prev?.lastSpokeAt ?? 0,
      joinedAt: fresh.joinedAt,
      pendingUntil: undefined,
      queue: Promise.resolve(),
    });
    this.broadcastRoster([fresh], userId);
    return {
      participants: [...this.roster.values()],
      ...(this.organizer && { organizer: this.organizer }),
      max: this.o.maxParticipants,
      rtpCapabilities: slot.router.rtpCapabilities,
    };
  }

  /** A participant left (hung up, or was dropped). */
  leave(userId: string): void {
    const m = this.members.get(userId);
    if (m) this.removeMember(m);
    const e = this.roster.get(userId);
    if (e && !e.left) {
      const left = { ...e, left: true, v: e.v + 1 };
      this.roster.set(userId, left);
      this.broadcastRoster([left]);
    }
    this.scheduleRefresh();
  }

  private removeMember(m: Member): void {
    this.members.delete(m.userId);
    m.slot.members--;
    for (const t of m.transports.values()) t.close();
    m.transports.clear();
    m.producers.clear();
    m.consumers.clear();
  }

  private update(m: Member, entry: CallParticipant): void {
    if (entry.userId !== m.userId) return;
    const prev = this.roster.get(m.userId);
    if (prev && prev.v >= entry.v) return;
    const next = { ...entry, left: false };
    this.roster.set(m.userId, next);
    m.entry = next;
    this.broadcastRoster([next], m.userId);
  }

  /** An entry changed: tell everyone (but the one it came from, who knows it). */
  private broadcastRoster(changed: CallParticipant[], except?: string): void {
    for (const userId of this.members.keys()) {
      if (userId === except) continue;
      this.o.notify(userId, 'roster', { participants: changed });
    }
  }

  /** The organiser's own changes to the roster (spotlight) and removals, from the host's PC. */
  setEntry(entry: CallParticipant): void {
    const prev = this.roster.get(entry.userId);
    if (prev && prev.v >= entry.v) return;
    this.roster.set(entry.userId, entry);
    const m = this.members.get(entry.userId);
    if (m) m.entry = entry;
    this.broadcastRoster([entry]);
  }

  rosterEntries(): CallParticipant[] {
    return [...this.roster.values()];
  }

  isMember(userId: string): boolean {
    return this.members.has(userId);
  }

  private async createTransport(
    m: Member,
    data: {
      direction: 'send' | 'recv';
      kind: 'webrtc' | 'plain';
      rtpCapabilities?: Record<string, unknown> | undefined;
    },
  ) {
    const appData = { userId: m.userId, direction: data.direction };
    if (data.kind === 'plain') {
      if (!this.o.allowPlain) throw new Error('plain transports are for load tests only');
      const t = await m.slot.router.createPlainTransport({
        listenInfo: { protocol: 'udp', ip: this.o.listenIps[0] ?? '127.0.0.1' },
        rtcpMux: true,
        comedia: false,
        enableSrtp: true,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        appData,
      });
      this.addTransport(m, t, data);
      return {
        id: t.id,
        ip: t.tuple.localAddress ?? t.tuple.localIp,
        port: t.tuple.localPort,
        srtpParameters: t.srtpParameters,
      };
    }
    const t = await m.slot.router.createWebRtcTransport({
      webRtcServer: m.slot.server,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
      appData,
    });
    this.addTransport(m, t, data);
    return {
      id: t.id,
      iceParameters: t.iceParameters,
      iceCandidates: t.iceCandidates,
      dtlsParameters: t.dtlsParameters,
    };
  }

  private addTransport(
    m: Member,
    t: ms.Transport,
    data: { direction: 'send' | 'recv'; rtpCapabilities?: Record<string, unknown> | undefined },
  ): void {
    m.transports.set(t.id, t);
    if (data.direction === 'recv') {
      m.recv?.close();
      m.recv = t;
      m.consumers.clear();
      m.ready.clear();
      if (data.rtpCapabilities) m.rtpCapabilities = data.rtpCapabilities as ms.RtpCapabilities;
      this.enqueue(m, () => this.refreshMember(m));
    }
  }

  private async connectTransport(
    m: Member,
    data: {
      transportId: string;
      dtlsParameters?: Record<string, unknown> | undefined;
      ip?: string | undefined;
      port?: number | undefined;
      srtpParameters?: Record<string, unknown> | undefined;
    },
  ) {
    const t = m.transports.get(data.transportId);
    if (!t) throw new Error('unknown transport');
    if (data.dtlsParameters) {
      await t.connect({ dtlsParameters: data.dtlsParameters as unknown as ms.DtlsParameters });
    } else {
      await t.connect({
        ip: data.ip,
        port: data.port,
        srtpParameters: data.srtpParameters as unknown as ms.SrtpParameters,
      });
    }
    return {};
  }

  private async produce(
    m: Member,
    data: {
      transportId: string;
      kind: 'audio' | 'video';
      source: RelaySource;
      rtpParameters: Record<string, unknown>;
      paused?: boolean | undefined;
    },
  ) {
    const t = m.transports.get(data.transportId);
    if (!t || t === m.recv) throw new Error('unknown send transport');
    if ((data.source === 'mic') !== (data.kind === 'audio')) throw new Error('wrong kind');
    m.producers.get(data.source)?.close();
    if (data.paused) m.ownerPaused.add(data.source);
    else m.ownerPaused.delete(data.source);
    const producer = await t.produce({
      kind: data.kind,
      rtpParameters: data.rtpParameters as unknown as ms.RtpParameters,
      paused: data.paused === true,
      appData: { userId: m.userId, source: data.source },
    });
    m.producers.set(data.source, producer);
    if (data.kind === 'audio' && this.observer) {
      const main = this.slots[0]!;
      await this.pipe(producer, m.slot, main);
      await this.observer.addProducer({ producerId: producer.id }).catch(() => {});
    }
    // A screen share replaces any other (one sharer at a time).
    if (data.source === 'screen') {
      for (const other of this.members.values()) {
        if (other === m) continue;
        const s = other.producers.get('screen');
        if (!s) continue;
        s.close();
        other.producers.delete('screen');
        this.o.notify(other.userId, 'producerPaused', { source: 'screen', paused: true });
      }
    }
    this.scheduleRefresh();
    return { id: producer.id };
  }

  // -------------------------------------------------------------------------
  // Who receives what
  // -------------------------------------------------------------------------

  /** Members with a live camera, most recent speakers first. */
  private cameraOrder(): Member[] {
    return [...this.members.values()]
      .filter((m) => m.producers.has('camera') && !m.ownerPaused.has('camera'))
      .sort(
        (a, b) =>
          b.lastSpokeAt - a.lastSpokeAt ||
          a.joinedAt - b.joinedAt ||
          (a.userId < b.userId ? -1 : 1),
      );
  }

  /** Producer id to "should flow now" for one viewer. */
  private wanted(m: Member): Map<string, boolean> {
    const out = new Map<string, boolean>();
    const top = new Set(this.speakers);
    for (const other of this.members.values()) {
      if (other === m) continue;
      const mic = other.producers.get('mic');
      // Every voice is consumed, but only the loudest few flow.
      if (mic) out.set(mic.id, top.has(other.userId) && !other.ownerPaused.has('mic'));
      const screen = other.producers.get('screen');
      if (screen) out.set(screen.id, !other.ownerPaused.has('screen'));
    }
    const cams = this.cameraOrder().filter((c) => c !== m);
    const start = Math.min(m.page * RELAY_VIDEO_TILES, Math.max(0, cams.length - 1));
    for (const c of cams.slice(start, start + RELAY_VIDEO_TILES))
      out.set(c.producers.get('camera')!.id, true);
    return out;
  }

  /** Bring one viewer's consumers in line with what it should receive. */
  private async refreshMember(m: Member): Promise<void> {
    if (!m.recv || !m.rtpCapabilities || this.members.get(m.userId) !== m) return;
    const want = this.wanted(m);
    for (const [producerId, consumer] of [...m.consumers]) {
      if (want.has(producerId) && !consumer.closed) continue;
      consumer.close();
      m.consumers.delete(producerId);
      m.ready.delete(consumer.id);
      this.o.notify(m.userId, 'consumerClosed', { consumerId: consumer.id });
    }
    const tiles = [...want.keys()].filter(
      (id) => this.producerById(id)?.p.appData['source'] === 'camera',
    ).length;
    const layer = m.layer ?? (tiles <= 4 ? 1 : 0);
    for (const [producerId, flow] of want) {
      let consumer = m.consumers.get(producerId);
      if (!consumer) {
        const found = this.producerById(producerId);
        if (!found) continue;
        await this.pipe(found.p, found.owner.slot, m.slot);
        if (!m.slot.router.canConsume({ producerId, rtpCapabilities: m.rtpCapabilities })) continue;
        if (this.members.get(m.userId) !== m || !m.recv || m.recv.closed) return;
        consumer = await m.recv.consume({
          producerId,
          rtpCapabilities: m.rtpCapabilities,
          paused: true,
          appData: { userId: found.owner.userId, source: found.source },
        });
        m.consumers.set(producerId, consumer);
        const c = consumer;
        c.on('producerclose', () => {
          m.consumers.delete(producerId);
          m.ready.delete(c.id);
          this.o.notify(m.userId, 'consumerClosed', { consumerId: c.id });
        });
        this.o.notify(m.userId, 'newConsumer', {
          consumerId: c.id,
          producerId,
          userId: found.owner.userId,
          source: found.source,
          kind: c.kind,
          rtpParameters: c.rtpParameters,
          paused: true,
        });
      }
      if (consumer.kind === 'video' && consumer.type === 'simulcast') {
        const spatialLayer = this.producerById(producerId)?.source === 'screen' ? 2 : layer;
        await consumer.setPreferredLayers({ spatialLayer, temporalLayer: 2 }).catch(() => {});
      }
      // Paused until the client says it is ready; then as the policy says.
      if (!m.ready.has(consumer.id)) continue;
      if (flow && consumer.paused) await consumer.resume();
      else if (!flow && !consumer.paused) await consumer.pause();
    }
  }

  private producerById(
    id: string,
  ): { p: ms.Producer; owner: Member; source: RelaySource } | undefined {
    for (const owner of this.members.values())
      for (const [source, p] of owner.producers) if (p.id === id) return { p, owner, source };
    return undefined;
  }

  private enqueue(m: Member, task: () => Promise<void>): void {
    m.queue = m.queue.then(task).catch((err: unknown) => {
      if (!this.closed)
        this.o.logger.warn('relay consumer update failed', { userId: m.userId, err: String(err) });
    });
  }

  /** Re-plan everyone's consumers soon (bursts of changes coalesce). */
  private scheduleRefresh(): void {
    if (this.refreshTimer || this.closed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      for (const m of this.members.values()) this.enqueue(m, () => this.refreshMember(m));
      void this.pauseUnwatched();
    }, 50);
  }

  /** A camera nobody receives stops at its sender; it starts again when someone does. */
  private async pauseUnwatched(): Promise<void> {
    const watched = new Set<string>();
    for (const m of this.members.values())
      for (const [id, flow] of this.wanted(m)) if (flow) watched.add(id);
    for (const owner of this.members.values()) {
      const cam = owner.producers.get('camera');
      if (!cam || owner.ownerPaused.has('camera')) continue;
      const unwatched = !watched.has(cam.id);
      const was = (cam.appData as { unwatched?: boolean }).unwatched === true;
      if (unwatched === was) continue;
      cam.appData['unwatched'] = unwatched;
      this.o.notify(owner.userId, 'producerPaused', { source: 'camera', paused: unwatched });
    }
  }

  private async applyProducerPause(m: Member, source: RelaySource): Promise<void> {
    const p = m.producers.get(source);
    if (!p) return;
    if (m.ownerPaused.has(source) && !p.paused) await p.pause();
    else if (!m.ownerPaused.has(source) && p.paused) await p.resume();
  }

  private onSpeakers(userIds: string[]): void {
    const now = Date.now();
    for (const u of userIds) {
      const m = this.members.get(u);
      if (m) m.lastSpokeAt = now;
    }
    const changed = userIds.join() !== this.speakers.join();
    // Keep the last speakers flowing through short silences; replace them when others speak.
    if (!changed) return;
    this.speakers = userIds;
    this.scheduleRefresh();
    this.notifySpeakers();
  }

  private notifySpeakers(): void {
    const now = Date.now();
    if (now - this.lastSpeakersNotify < SPEAKERS_NOTIFY_MS) {
      this.speakersTimer ??= setTimeout(() => {
        this.speakersTimer = undefined;
        this.notifySpeakers();
      }, SPEAKERS_NOTIFY_MS);
      return;
    }
    this.lastSpeakersNotify = now;
    for (const userId of this.members.keys())
      this.o.notify(userId, 'speakers', { userIds: this.speakers });
  }

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  private async sample(): Promise<void> {
    if (this.closed) return;
    try {
      const usage = await Promise.all(this.slots.map((s) => s.worker.getResourceUsage()));
      const workerMs = usage.reduce((a, u) => a + u.ru_utime + u.ru_stime, 0);
      const proc = process.cpuUsage();
      const procUs = proc.user + proc.system;
      const now = performance.now();
      const elapsed = now - this.lastCpu.at;
      const used = workerMs - this.lastCpu.workerMs + (procUs - this.lastCpu.procUs) / 1000;
      const cpuPercent = elapsed > 0 ? (used / elapsed / cpus().length) * 100 : 0;
      this.lastCpu = { at: now, workerMs, procUs };
      let sent = 0;
      let recv = 0;
      let consumers = 0;
      let producers = 0;
      for (const m of this.members.values()) {
        consumers += m.consumers.size;
        producers += m.producers.size;
        for (const t of m.transports.values()) {
          const stats = (await t.getStats().catch(() => [])) as Array<{
            bytesSent?: number;
            bytesReceived?: number;
          }>;
          sent += stats[0]?.bytesSent ?? 0;
          recv += stats[0]?.bytesReceived ?? 0;
        }
      }
      const bytesElapsed = (now - this.lastBytes.at) / 1000;
      const sendMbps =
        bytesElapsed > 0 ? Math.max(0, ((sent - this.lastBytes.sent) * 8) / 1e6 / bytesElapsed) : 0;
      const recvMbps =
        bytesElapsed > 0 ? Math.max(0, ((recv - this.lastBytes.recv) * 8) / 1e6 / bytesElapsed) : 0;
      this.lastBytes = { at: now, sent, recv };
      this.current = {
        participants: this.members.size,
        workers: this.slots.length,
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        workerCpuMs: workerMs,
        sendMbps: Math.round(sendMbps * 10) / 10,
        recvMbps: Math.round(recvMbps * 10) / 10,
        consumers,
        producers,
      };
    } catch (err) {
      this.o.logger.debug('relay stats failed', { err: String(err) });
    }
  }

  stats(): RelayStats {
    return { ...this.current, participants: this.members.size };
  }

  /** Worker process ids (for load tests that pin or measure them). */
  workerPids(): number[] {
    return this.slots.map((s) => s.worker.pid);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.speakersTimer) clearTimeout(this.speakersTimer);
    for (const s of this.slots) s.worker.close();
    this.members.clear();
  }
}

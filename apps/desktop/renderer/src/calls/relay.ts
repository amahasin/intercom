/**
 * Media for a meeting on host relay (M6): one send and one receive WebRTC transport to the
 * host's mediasoup, through mediasoup-client. The camera goes up as three simulcast layers
 * (180p, 360p, 720p); the host forwards each person the loudest voices, a page of cameras
 * and the shared screen. Requests go through the core, which carries them to the host over
 * the authenticated peer link (so the host's DTLS fingerprint is bound to its identity).
 */
import { Device, type types as mc } from 'mediasoup-client';
import type { RelaySource } from '@officemesh/protocol';
import { core } from '../state.ts';

export interface RelayRemote {
  userId: string;
  source: RelaySource;
  kind: 'audio' | 'video';
  track: MediaStreamTrack;
  consumerId: string;
}

export interface RelayEvents {
  added(remote: RelayRemote): void;
  removed(remote: RelayRemote): void;
  /** The loudest speakers now. */
  speakers(userIds: string[]): void;
  /** The host stopped (or restarted) receiving a source of ours: stop or start sending it. */
  senderPaused(source: RelaySource, paused: boolean): void;
  /** How many cameras the host's speaker order holds (for paging). */
  cameras(count: number): void;
}

/** Camera simulcast layers: 180p, 360p and 720p from a 720p capture. */
const CAMERA_ENCODINGS: RTCRtpEncodingParameters[] = [
  { rid: 'r0', scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { rid: 'r1', scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { rid: 'r2', scaleResolutionDownBy: 1, maxBitrate: 1_200_000 },
];

export class RelayMedia {
  readonly callId: string;
  readonly epoch: number;
  private readonly events: RelayEvents;
  private device: Device | undefined;
  private send: mc.Transport | undefined;
  private recv: mc.Transport | undefined;
  private readonly producers = new Map<RelaySource, mc.Producer>();
  private readonly consumers = new Map<string, { consumer: mc.Consumer; remote: RelayRemote }>();
  /** Notifications that arrived before the receive transport was ready. */
  private early: Array<{ method: string; data: unknown }> | undefined = [];
  private resumeQueue: string[] = [];
  private closed = false;
  connectedAt: number | undefined;
  readonly startedAt = Date.now();

  constructor(callId: string, epoch: number, events: RelayEvents) {
    this.callId = callId;
    this.epoch = epoch;
    this.events = events;
  }

  private req<T>(method: string, data: unknown = {}): Promise<T> {
    return core.invoke('calls.relay', {
      callId: this.callId,
      epoch: this.epoch,
      method: method as 'capabilities',
      data,
    }) as Promise<T>;
  }

  async start(): Promise<void> {
    const { rtpCapabilities } = await this.req<{ rtpCapabilities: mc.RtpCapabilities }>(
      'capabilities',
    );
    const device = new Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    this.device = device;
    const sendParams = await this.req<mc.TransportOptions>('createTransport', {
      direction: 'send',
    });
    const send = device.createSendTransport({ ...sendParams, iceServers: [] });
    send.on('connect', ({ dtlsParameters }, ok, fail) => {
      this.req('connectTransport', { transportId: send.id, dtlsParameters }).then(
        () => ok(),
        (e: unknown) => fail(e instanceof Error ? e : new Error(String(e))),
      );
    });
    send.on('produce', ({ kind, rtpParameters, appData }, ok, fail) => {
      this.req<{ id: string }>('produce', {
        transportId: send.id,
        kind,
        source: appData['source'],
        rtpParameters,
        paused: appData['paused'] === true,
      }).then(ok, (e: unknown) => fail(e instanceof Error ? e : new Error(String(e))));
    });
    send.on('connectionstatechange', (state) => {
      if (state === 'connected') this.connectedAt ??= Date.now();
    });
    this.send = send;
    const recvParams = await this.req<mc.TransportOptions>('createTransport', {
      direction: 'recv',
      rtpCapabilities: device.rtpCapabilities,
    });
    const recv = device.createRecvTransport({ ...recvParams, iceServers: [] });
    recv.on('connect', ({ dtlsParameters }, ok, fail) => {
      this.req('connectTransport', { transportId: recv.id, dtlsParameters }).then(
        () => ok(),
        (e: unknown) => fail(e instanceof Error ? e : new Error(String(e))),
      );
    });
    recv.on('connectionstatechange', (state) => {
      if (state === 'connected') this.connectedAt ??= Date.now();
    });
    this.recv = recv;
    const early = this.early ?? [];
    this.early = undefined;
    for (const n of early) await this.onNotify(n.method, n.data);
  }

  /** Send (or replace, or stop sending) one of our sources. */
  async setSource(
    source: RelaySource,
    track: MediaStreamTrack | null,
    paused = false,
  ): Promise<void> {
    if (this.closed || !this.send) return;
    const existing = this.producers.get(source);
    if (!track) {
      if (existing) {
        existing.close();
        this.producers.delete(source);
        await this.req('closeProducer', { source }).catch(() => {});
      }
      return;
    }
    if (existing && !existing.closed) {
      if (existing.track !== track) await existing.replaceTrack({ track });
      await this.pause(source, paused);
      return;
    }
    const producer = await this.send.produce({
      track,
      ...(source === 'camera' && { encodings: CAMERA_ENCODINGS }),
      ...(source === 'screen' && {
        // The host carries this to everyone: 8 Mbit/s keeps a 1440p screen sharp.
        encodings: [{ maxBitrate: 8_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 }],
      }),
      ...(source === 'mic' && { codecOptions: { opusDtx: true, opusFec: true } }),
      stopTracks: false,
      zeroRtpOnPause: true,
      disableTrackOnPause: false,
      appData: { source, paused },
    });
    if (paused) producer.pause();
    this.producers.set(source, producer);
  }

  async pause(source: RelaySource, paused: boolean): Promise<void> {
    const p = this.producers.get(source);
    if (!p || p.paused === paused) return;
    if (paused) p.pause();
    else p.resume();
    await this.req('pauseProducer', { source, paused }).catch(() => {});
  }

  /** The host asked us to stop or restart sending (nobody watches our camera). */
  private hostPaused(source: RelaySource, paused: boolean): void {
    const p = this.producers.get(source);
    if (!p) return;
    if (paused) p.pause();
    else p.resume();
  }

  async setView(page: number): Promise<void> {
    await this.req('setView', { page }).catch(() => {});
  }

  async onNotify(method: string, data: unknown): Promise<void> {
    if (this.closed) return;
    if (this.early) {
      this.early.push({ method, data });
      return;
    }
    switch (method) {
      case 'newConsumer': {
        const d = data as {
          consumerId: string;
          producerId: string;
          userId: string;
          source: RelaySource;
          kind: 'audio' | 'video';
          rtpParameters: mc.RtpParameters;
        };
        if (!this.recv) return;
        const consumer = await this.recv.consume({
          id: d.consumerId,
          producerId: d.producerId,
          kind: d.kind,
          rtpParameters: d.rtpParameters,
        });
        const remote: RelayRemote = {
          userId: d.userId,
          source: d.source,
          kind: d.kind,
          track: consumer.track,
          consumerId: d.consumerId,
        };
        this.consumers.set(d.consumerId, { consumer, remote });
        this.events.added(remote);
        this.resumeQueue.push(d.consumerId);
        if (this.resumeQueue.length === 1)
          window.setTimeout(() => {
            const consumerIds = this.resumeQueue.splice(0);
            void this.req('resumeConsumer', { consumerIds }).catch(() => {});
          }, 30);
        return;
      }
      case 'consumerClosed': {
        const id = (data as { consumerId: string }).consumerId;
        const entry = this.consumers.get(id);
        if (!entry) return;
        this.consumers.delete(id);
        entry.consumer.close();
        this.events.removed(entry.remote);
        return;
      }
      case 'producerPaused': {
        const d = data as { source: RelaySource; paused: boolean };
        this.hostPaused(d.source, d.paused);
        this.events.senderPaused(d.source, d.paused);
        return;
      }
      case 'speakers':
        this.events.speakers((data as { userIds: string[] }).userIds);
        return;
      case 'heartbeat':
        this.events.cameras((data as { cameras: number }).cameras);
        return;
    }
  }

  /** Streams received now, for recording and stats. */
  remotes(): RelayRemote[] {
    return [...this.consumers.values()].map((c) => c.remote);
  }

  async stats(): Promise<{ audioPackets: number; videoFrames: number; consumers: number }> {
    let audioPackets = 0;
    let videoFrames = 0;
    if (this.recv) {
      const report = await this.recv.getStats();
      report.forEach(
        (s: { type: string; kind?: string; packetsReceived?: number; framesDecoded?: number }) => {
          if (s.type !== 'inbound-rtp') return;
          if (s.kind === 'audio') audioPackets += s.packetsReceived ?? 0;
          if (s.kind === 'video') videoFrames += s.framesDecoded ?? 0;
        },
      );
    }
    return { audioPackets, videoFrames, consumers: this.consumers.size };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { remote } of this.consumers.values()) this.events.removed(remote);
    this.consumers.clear();
    this.send?.close();
    this.recv?.close();
  }
}

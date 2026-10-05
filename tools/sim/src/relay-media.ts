/**
 * Simulated meeting media for host-relay tests (M6). A simulated participant cannot run
 * Chromium, so it uses mediasoup in the test process: synthetic Opus and VP8 packets are
 * fed into a DirectTransport, forwarded over a PlainTransport with SRTP to the host's
 * plain transport, and the host's consumers come back the same way. The host does the
 * same per-packet work (SRTP, forwarding, layer selection) as for a WebRTC participant;
 * only ICE and DTLS set-up are skipped.
 *
 * Audio: 50 packets a second of 100-byte "Opus" with an audio-level header extension, so
 * the host's loudest-speaker selection works. Video: three simulcast layers (180p, 360p,
 * 720p at about 150, 500 and 1,200 kbps), 30 frames a second, a key frame every 2 s with
 * VP8 payload descriptors mediasoup recognises.
 */
import type { types as ms } from 'mediasoup';

export type RelayRequest = (method: string, data: unknown) => Promise<unknown>;

const AUDIO_LEVEL_URI = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';
const LAYER_KBPS = [150, 500, 1_200];
const MTU_PAYLOAD = 1_100;

interface Stream {
  producer: ms.Producer;
  ssrc: number;
  pt: number;
  seq: number;
  ts: number;
  pictureId: number;
  tl0: number;
  /** Bytes per frame (video). */
  frameBytes: number;
}

function rtpHeader(s: Stream, marker: boolean, ext?: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head[0] = 0x80 | (ext ? 0x10 : 0);
  head[1] = (marker ? 0x80 : 0) | s.pt;
  head.writeUInt16BE(s.seq & 0xffff, 2);
  head.writeUInt32BE(s.ts >>> 0, 4);
  head.writeUInt32BE(s.ssrc >>> 0, 8);
  s.seq = (s.seq + 1) & 0xffff;
  return ext ? Buffer.concat([head, ext]) : head;
}

/** One-byte header extension (RFC 8285) carrying ssrc-audio-level. */
function audioLevelExt(id: number, levelDbov: number, voice: boolean): Buffer {
  const ext = Buffer.alloc(8);
  ext.writeUInt16BE(0xbede, 0);
  ext.writeUInt16BE(1, 2);
  ext[4] = (id << 4) | 0; // length 1 byte
  ext[5] = (voice ? 0x80 : 0) | Math.min(127, Math.max(0, levelDbov));
  return ext;
}

/** VP8 payload descriptor (picture id, TL0PICIDX, TID) plus, on a key frame's first packet, the frame header. */
function vp8Payload(s: Stream, first: boolean, key: boolean, size: number): Buffer {
  const d = Buffer.alloc(6);
  d[0] = 0x80 | (first ? 0x10 : 0); // X, S
  d[1] = 0xe0; // I, L, T
  d.writeUInt16BE(0x8000 | (s.pictureId & 0x7fff), 2);
  d[4] = s.tl0 & 0xff;
  d[5] = 0x00; // TID 0
  const body = Buffer.alloc(Math.max(10, size));
  if (first) {
    // P bit 0 marks a key frame; then the key frame start code and 640x360.
    body[0] = key ? 0x10 : 0x11;
    body[1] = 0x02;
    body[2] = 0x00;
    if (key) {
      body[3] = 0x9d;
      body[4] = 0x01;
      body[5] = 0x2a;
      body.writeUInt16LE(640, 6);
      body.writeUInt16LE(360, 8);
    }
  }
  return Buffer.concat([d, body]);
}

export interface SimMediaOptions {
  router: ms.Router;
  request: RelayRequest;
  /** Address of this process's plain transports as the host should send to. */
  ip: string;
  mic: boolean;
  camera: boolean;
}

export interface SimMediaStats {
  /** RTP bytes received from the host so far. */
  bytesIn: number;
  /** When bytes last arrived (ms since epoch; 0: never). */
  lastIn: number;
  /** When media first arrived on this connection (after joining or a hand-over). */
  firstIn: number;
  consumers: number;
  audioConsumers: number;
  videoConsumers: number;
}

/** One simulated participant's media, connected to the current relay host. */
export class SimMediaClient {
  private readonly o: SimMediaOptions;
  private direct: ms.DirectTransport | undefined;
  private send: ms.PlainTransport | undefined;
  private recv: ms.PlainTransport | undefined;
  private readonly streams: Stream[] = [];
  private audio: Stream | undefined;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly consumers = new Map<string, 'audio' | 'video'>();
  /** Our side of each stream the host sends us, by consumer id. */
  private readonly incoming = new Map<string, ms.Producer>();
  private closed = false;
  private readonly resume: string[] = [];
  /** Loudness in dBov (0 loud, 127 silent). */
  level = 127;
  cameraPaused = false;
  stats: SimMediaStats = {
    bytesIn: 0,
    lastIn: 0,
    firstIn: 0,
    consumers: 0,
    audioConsumers: 0,
    videoConsumers: 0,
  };

  constructor(options: SimMediaOptions) {
    this.o = options;
  }

  private async plain(): Promise<ms.PlainTransport> {
    return this.o.router.createPlainTransport({
      listenInfo: { protocol: 'udp', ip: this.o.ip },
      rtcpMux: true,
      comedia: false,
      enableSrtp: true,
      srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
    });
  }

  /** Connect both ways to the host and start sending. */
  async start(): Promise<void> {
    const { request, router } = this.o;
    // Upstream.
    const up = (await request('createTransport', { direction: 'send', kind: 'plain' })) as {
      id: string;
      ip: string;
      port: number;
      srtpParameters: ms.SrtpParameters;
    };
    this.send = await this.plain();
    await this.send.connect({ ip: up.ip, port: up.port, srtpParameters: up.srtpParameters });
    await request('connectTransport', {
      transportId: up.id,
      ip: this.o.ip,
      port: this.send.tuple.localPort,
      srtpParameters: this.send.srtpParameters,
    });
    this.direct = await router.createDirectTransport();
    const ext = router.rtpCapabilities.headerExtensions?.find(
      (h) => h.uri === AUDIO_LEVEL_URI && h.kind === 'audio',
    );
    if (this.o.mic) {
      const ssrc = 1_000_000 + Math.floor(Math.random() * 1e9);
      const producer = await this.direct.produce({
        kind: 'audio',
        rtpParameters: {
          codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48_000, channels: 2 }],
          encodings: [{ ssrc }],
          headerExtensions: ext ? [{ uri: AUDIO_LEVEL_URI, id: ext.preferredId }] : [],
        },
      });
      const consumer = await this.send.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
      });
      this.audio = {
        producer,
        ssrc,
        pt: 100,
        seq: 0,
        ts: 0,
        pictureId: 0,
        tl0: 0,
        frameBytes: 100,
      };
      await request('produce', {
        transportId: up.id,
        kind: 'audio',
        source: 'mic',
        rtpParameters: consumer.rtpParameters,
      });
      const extId = ext?.preferredId ?? 1;
      this.timers.push(
        setInterval(() => {
          const s = this.audio!;
          s.ts += 960;
          const voice = this.level < 60;
          void s.producer.send(
            Buffer.concat([
              rtpHeader(s, false, audioLevelExt(extId, this.level, voice)),
              Buffer.alloc(100, 0xf8),
            ]),
          );
        }, 20),
      );
    }
    if (this.o.camera) {
      const layers: ms.Consumer[] = [];
      for (const kbps of LAYER_KBPS) {
        const ssrc = 1_000_000 + Math.floor(Math.random() * 1e9);
        const producer = await this.direct.produce({
          kind: 'video',
          rtpParameters: {
            codecs: [{ mimeType: 'video/VP8', payloadType: 101, clockRate: 90_000 }],
            encodings: [{ ssrc }],
          },
        });
        layers.push(
          await this.send.consume({
            producerId: producer.id,
            rtpCapabilities: router.rtpCapabilities,
          }),
        );
        this.streams.push({
          producer,
          ssrc,
          pt: 101,
          seq: 0,
          ts: 0,
          pictureId: 0,
          tl0: 0,
          frameBytes: Math.round((kbps * 1000) / 8 / 30),
        });
      }
      const base = layers[0]!.rtpParameters;
      await request('produce', {
        transportId: up.id,
        kind: 'video',
        source: 'camera',
        rtpParameters: {
          ...base,
          encodings: layers.map((c, i) => ({
            ssrc: c.rtpParameters.encodings![0]!.ssrc,
            scalabilityMode: 'L1T1',
            maxBitrate: LAYER_KBPS[i]! * 1000,
          })),
        },
      });
      let frame = 0;
      this.timers.push(
        setInterval(() => {
          if (this.cameraPaused) return;
          const key = frame % 60 === 0;
          frame++;
          for (const s of this.streams) {
            s.ts += 3000;
            s.pictureId++;
            s.tl0++;
            const bytes = key ? s.frameBytes * 3 : s.frameBytes;
            const packets = Math.max(1, Math.ceil(bytes / MTU_PAYLOAD));
            for (let i = 0; i < packets; i++) {
              const size = Math.min(MTU_PAYLOAD, bytes - i * MTU_PAYLOAD);
              void s.producer.send(
                Buffer.concat([rtpHeader(s, i === packets - 1), vp8Payload(s, i === 0, key, size)]),
              );
            }
          }
        }, 33),
      );
    }
    // Downstream.
    const down = (await request('createTransport', {
      direction: 'recv',
      kind: 'plain',
      rtpCapabilities: router.rtpCapabilities,
    })) as { id: string; ip: string; port: number; srtpParameters: ms.SrtpParameters };
    this.recv = await this.plain();
    await this.recv.connect({ ip: down.ip, port: down.port, srtpParameters: down.srtpParameters });
    await request('connectTransport', {
      transportId: down.id,
      ip: this.o.ip,
      port: this.recv.tuple.localPort,
      srtpParameters: this.recv.srtpParameters,
    });
    this.timers.push(setInterval(() => void this.poll(), 500));
  }

  /** Notifications from the host for this participant. */
  async onNotify(method: string, data: unknown): Promise<void> {
    if (this.closed) return;
    if (method === 'newConsumer') {
      const c = data as {
        consumerId: string;
        kind: 'audio' | 'video';
        rtpParameters: ms.RtpParameters;
      };
      this.consumers.set(c.consumerId, c.kind);
      // Accept the stream on our side, so its packets are received and counted.
      if (this.recv) {
        const p = await this.recv
          .produce({ kind: c.kind, rtpParameters: c.rtpParameters })
          .catch(() => undefined);
        if (p) this.incoming.set(c.consumerId, p);
      }
      this.resume.push(c.consumerId);
      if (this.resume.length === 1)
        setTimeout(() => {
          const consumerIds = this.resume.splice(0);
          void this.o.request('resumeConsumer', { consumerIds }).catch(() => {});
        }, 30);
    } else if (method === 'consumerClosed') {
      const id = (data as { consumerId: string }).consumerId;
      this.consumers.delete(id);
      this.incoming.get(id)?.close();
      this.incoming.delete(id);
    } else if (method === 'producerPaused') {
      const d = data as { source: string; paused: boolean };
      if (d.source === 'camera') this.cameraPaused = d.paused;
    }
    let audio = 0;
    for (const k of this.consumers.values()) if (k === 'audio') audio++;
    this.stats.consumers = this.consumers.size;
    this.stats.audioConsumers = audio;
    this.stats.videoConsumers = this.consumers.size - audio;
  }

  private async poll(): Promise<void> {
    if (!this.recv || this.closed) return;
    const [s] = (await this.recv.getStats().catch(() => [])) as Array<{
      rtpBytesReceived?: number;
      bytesReceived?: number;
    }>;
    const bytes = s?.rtpBytesReceived ?? s?.bytesReceived ?? 0;
    if (bytes > this.stats.bytesIn) {
      this.stats.bytesIn = bytes;
      this.stats.lastIn = Date.now();
      this.stats.firstIn ||= this.stats.lastIn;
    }
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.direct?.close();
    this.send?.close();
    this.recv?.close();
  }
}

/**
 * Local meeting recording (plan section 9): the call as everyone sees it (a grid of
 * tiles, or the shared screen) plus every participant's audio, recorded with MediaRecorder.
 * Pieces go to the core every second; when stopped the file is shared to the meeting chat.
 * MP4 (H.264 and AAC) is preferred: Windows Media Player plays it with no extra codecs.
 */
import { core } from '../state.ts';

export interface RecordingTile {
  name: string;
  video: MediaStream | undefined;
}

export interface RecordingSources {
  tiles: RecordingTile[];
  screen: MediaStream | undefined;
  audio: MediaStream[];
}

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 25;

export const RECORDING_TYPES = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', file: 'video/mp4' },
  { mime: 'video/webm;codecs=vp9,opus', file: 'video/webm' },
] as const;

export class Recorder {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio = new AudioContext();
  private readonly mix = this.audio.createMediaStreamDestination();
  private readonly connected = new Set<string>();
  private readonly videos = new Map<MediaStream, HTMLVideoElement>();
  private readonly recorder: MediaRecorder;
  private timer: number | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  readonly startedAt = Date.now();

  private readonly id: string;
  private readonly sources: () => RecordingSources;

  private constructor(id: string, sources: () => RecordingSources, mime: string) {
    this.id = id;
    this.sources = sources;
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.ctx = this.canvas.getContext('2d')!;
    const stream = new MediaStream([
      ...this.canvas.captureStream(FPS).getVideoTracks(),
      ...this.mix.stream.getAudioTracks(),
    ]);
    this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      this.pending = this.pending.then(async () =>
        core.invoke('recordings.append', {
          id: this.id,
          data: new Uint8Array(await e.data.arrayBuffer()),
        }),
      );
    };
  }

  static async start(title: string, sources: () => RecordingSources): Promise<Recorder> {
    const type = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t.mime));
    if (!type) throw new Error('this PC cannot record video');
    const stamp = new Date().toLocaleString().replace(/[/:]/g, '-');
    const { id } = await core.invoke('recordings.begin', {
      name: `${title || 'Meeting'} recording ${stamp}`,
      mime: type.file,
    });
    const rec = new Recorder(id, sources, type.mime);
    rec.draw();
    rec.timer = window.setInterval(() => rec.draw(), 1_000 / FPS);
    rec.recorder.start(1_000);
    return rec;
  }

  /** Stop and share the file to `convId`; resolves when the file is in the chat. */
  async stop(convId: string): Promise<void> {
    window.clearInterval(this.timer);
    const stopped = new Promise<void>((resolve) => {
      this.recorder.onstop = () => resolve();
    });
    this.recorder.stop();
    await stopped;
    await this.pending;
    this.cleanup();
    await core.invoke('recordings.finish', { id: this.id, convId });
  }

  async abort(): Promise<void> {
    window.clearInterval(this.timer);
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    this.cleanup();
    await core.invoke('recordings.abort', { id: this.id }).catch(() => {});
  }

  private cleanup(): void {
    for (const v of this.videos.values()) v.srcObject = null;
    this.videos.clear();
    void this.audio.close();
  }

  private videoFor(stream: MediaStream): HTMLVideoElement {
    let v = this.videos.get(stream);
    if (!v) {
      v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      void v.play().catch(() => {});
      this.videos.set(stream, v);
    }
    return v;
  }

  private draw(): void {
    const { tiles, screen, audio } = this.sources();
    // Everyone's sound, joined as people arrive.
    for (const s of audio) {
      for (const t of s.getAudioTracks()) {
        if (this.connected.has(t.id)) continue;
        this.connected.add(t.id);
        this.audio.createMediaStreamSource(new MediaStream([t])).connect(this.mix);
      }
    }
    const ctx = this.ctx;
    ctx.fillStyle = '#1b1a19';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    if (screen) {
      this.fit(this.videoFor(screen), 0, 0, WIDTH, HEIGHT, 'contain');
      return;
    }
    const n = Math.max(1, tiles.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const w = WIDTH / cols;
    const h = HEIGHT / rows;
    tiles.forEach((tile, i) => {
      const x = (i % cols) * w;
      const y = Math.floor(i / cols) * h;
      ctx.fillStyle = '#2d2c2b';
      ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
      if (tile.video && tile.video.getVideoTracks().length > 0) {
        this.fit(this.videoFor(tile.video), x + 4, y + 4, w - 8, h - 8, 'cover');
      } else {
        ctx.fillStyle = '#c8c6c4';
        ctx.font = `${Math.round(h / 5)}px Segoe UI, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(tile.name.slice(0, 1).toUpperCase(), x + w / 2, y + h / 2 + h / 14);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x + 8, y + h - 36, Math.min(w - 16, 16 + tile.name.length * 9), 26);
      ctx.fillStyle = '#ffffff';
      ctx.font = '16px Segoe UI, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(tile.name, x + 16, y + h - 17);
    });
  }

  private fit(
    v: HTMLVideoElement,
    x: number,
    y: number,
    w: number,
    h: number,
    mode: 'cover' | 'contain',
  ): void {
    const vw = v.videoWidth || 16;
    const vh = v.videoHeight || 9;
    const scale = mode === 'cover' ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.ctx.clip();
    this.ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    this.ctx.restore();
  }
}

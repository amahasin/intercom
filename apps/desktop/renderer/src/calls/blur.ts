/**
 * Background blur (plan section 9): on-device segmentation with MediaPipe's selfie
 * segmenter, applied as an insertable-streams transform (MediaStreamTrackProcessor in,
 * MediaStreamTrackGenerator out). The WebAssembly runtime and model ship with the app.
 */
import { ImageSegmenter } from '@mediapipe/tasks-vision';

/** Chromium's insertable streams, not yet in TypeScript's DOM library. */
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
  readonly readable: ReadableStream<VideoFrame>;
}
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' });
  readonly writable: WritableStream<VideoFrame>;
}

/** Segmentation runs on a small copy of the frame; the mask is scaled back up. */
const MASK_W = 256;
const MASK_H = 144;
/** Below this many frames a second (and well behind the camera), blur turns itself off. */
export const MIN_BLUR_FPS = 24;
const WARMUP_MS = 3_000;
const SLOW_FOR_MS = 5_000;

let segmenterPromise: Promise<ImageSegmenter> | undefined;

/** Load once per window; later pipelines reuse it. */
function loadSegmenter(): Promise<ImageSegmenter> {
  segmenterPromise ??= (async () => {
    const base = new URL('./mediapipe', location.href).href;
    // The SIMD build, named directly: MediaPipe's own detection picks the non-SIMD build
    // under this app's content security policy, though Chromium supports SIMD.
    const fileset = {
      wasmLoaderPath: `${base}/vision_wasm_internal.js`,
      wasmBinaryPath: `${base}/vision_wasm_internal.wasm`,
    };
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: `${base}/selfie_segmenter.tflite`, delegate },
      runningMode: 'VIDEO' as const,
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    try {
      return await ImageSegmenter.createFromOptions(fileset, options('GPU'));
    } catch {
      return ImageSegmenter.createFromOptions(fileset, options('CPU'));
    }
  })();
  segmenterPromise.catch(() => {
    segmenterPromise = undefined;
  });
  return segmenterPromise;
}

/** Test hook: extra milliseconds of work per frame, to exercise the automatic switch-off. */
function testDelay(): number {
  return (globalThis as { __officemeshBlurDelayMs?: number }).__officemeshBlurDelayMs ?? 0;
}

export class BlurPipeline {
  readonly output: MediaStreamTrackGenerator;
  /** Frames out per second, over the last second. */
  fps = 0;
  /** Frames in from the camera per second. */
  inputFps = 0;
  private stopped = false;
  private readonly started = performance.now();
  private slowSince: number | undefined;
  private onSlow: () => void;

  private constructor(output: MediaStreamTrackGenerator, onSlow: () => void) {
    this.output = output;
    this.onSlow = onSlow;
  }

  /** Start blurring `input`; resolves once the model is loaded and frames flow. */
  static async start(input: MediaStreamTrack, onSlow: () => void): Promise<BlurPipeline> {
    const segmenter = await loadSegmenter();
    const output = new MediaStreamTrackGenerator({ kind: 'video' });
    const pipe = new BlurPipeline(output, onSlow);
    void pipe.run(input, segmenter);
    return pipe;
  }

  stop(): void {
    this.stopped = true;
    this.output.stop();
  }

  private async run(input: MediaStreamTrack, segmenter: ImageSegmenter): Promise<void> {
    const processor = new MediaStreamTrackProcessor({ track: input, maxBufferSize: 1 });
    const reader = processor.readable.getReader();
    const writer = this.output.writable.getWriter();
    const small = new OffscreenCanvas(MASK_W, MASK_H);
    const smallCtx = small.getContext('2d', { willReadFrequently: false })!;
    const mask = new OffscreenCanvas(MASK_W, MASK_H);
    const maskCtx = mask.getContext('2d')!;
    const maskPixels = maskCtx.createImageData(MASK_W, MASK_H);
    const background = new OffscreenCanvas(MASK_W * 1.25, MASK_H * 1.25);
    const bgCtx = background.getContext('2d')!;
    bgCtx.filter = 'blur(5px)';
    let out: OffscreenCanvas | undefined;
    let outCtx: OffscreenCanvasRenderingContext2D | undefined;
    let person: OffscreenCanvas | undefined;
    let personCtx: OffscreenCanvasRenderingContext2D | undefined;
    let framesOut = 0;
    // What the camera delivers, whether or not we keep up (frames we are too slow for are
    // dropped before we see them, so counting our own reads would hide the problem).
    const stats = (input as MediaStreamTrack & { stats?: { totalFrames: number } }).stats;
    let sourceFrames = stats?.totalFrames ?? 0;
    const configuredFps = input.getSettings().frameRate ?? 30;
    let windowStart = performance.now();

    try {
      while (!this.stopped) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        const w = frame.displayWidth;
        const h = frame.displayHeight;
        if (!out || out.width !== w || out.height !== h) {
          out = new OffscreenCanvas(w, h);
          outCtx = out.getContext('2d')!;
          person = new OffscreenCanvas(w, h);
          personCtx = person.getContext('2d')!;
        }
        // Segment a small copy.
        smallCtx.drawImage(frame, 0, 0, MASK_W, MASK_H);
        segmenter.segmentForVideo(small, performance.now(), (result) => {
          const confidence = result.confidenceMasks?.[0]?.getAsFloat32Array();
          if (!confidence) return;
          const px = maskPixels.data;
          for (let i = 0; i < confidence.length; i++) px[i * 4 + 3] = confidence[i]! * 255;
        });
        maskCtx.putImageData(maskPixels, 0, 0);
        // Blurred background (small, then scaled up: cheap and soft).
        bgCtx.drawImage(frame, 0, 0, background.width, background.height);
        outCtx!.drawImage(background, 0, 0, w, h);
        // The person, cut out of the full-size frame by the scaled-up mask.
        personCtx!.globalCompositeOperation = 'copy';
        personCtx!.drawImage(frame, 0, 0);
        personCtx!.globalCompositeOperation = 'destination-in';
        personCtx!.drawImage(mask, 0, 0, w, h);
        outCtx!.drawImage(person!, 0, 0);
        const timestamp = frame.timestamp;
        frame.close();
        const delay = testDelay();
        if (delay > 0) {
          const until = performance.now() + delay;
          while (performance.now() < until) {
            // Busy-wait: simulate a slower PC.
          }
        }
        await writer.write(new VideoFrame(out!, { timestamp }));
        framesOut++;
        // Let the page breathe between frames: on a slow PC blur must not freeze the app.
        await new Promise((r) => setTimeout(r, 0));

        const now = performance.now();
        if (now - windowStart >= 1_000) {
          this.fps = Math.round((framesOut * 1_000) / (now - windowStart));
          const total = stats?.totalFrames;
          this.inputFps =
            total !== undefined
              ? Math.round(((total - sourceFrames) * 1_000) / (now - windowStart))
              : Math.round(configuredFps);
          if (total !== undefined) sourceFrames = total;
          framesOut = 0;
          windowStart = now;
          this.checkSpeed(now);
        }
      }
    } catch (err) {
      if (!this.stopped) console.warn('background blur stopped', err);
    } finally {
      reader.releaseLock();
      await writer.close().catch(() => {});
    }
  }

  /** Too slow for several seconds, and not merely because the camera is slow: give up. */
  private checkSpeed(now: number): void {
    if (now - this.started < WARMUP_MS) return;
    const slow = this.fps < Math.min(MIN_BLUR_FPS, this.inputFps * 0.8);
    if (!slow) {
      this.slowSince = undefined;
      return;
    }
    this.slowSince ??= now;
    if (now - this.slowSince >= SLOW_FOR_MS && !this.stopped) this.onSlow();
  }
}

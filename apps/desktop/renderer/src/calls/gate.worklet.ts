/**
 * The noise gate on the audio thread. It is built as a file of its own (`gate-worklet.js`, see
 * scripts/build.mjs) and loaded by `noise.ts`: a script processor ran on the page's main thread,
 * where a busy moment (video tiles, a whiteboard, recording) made the audio stutter, and a gap
 * in sound sent to others is heard as crackle.
 *
 * What goes out is `LOOKAHEAD_BLOCKS` blocks older than what comes in, so the gate can see a word
 * coming. Its decisions (made per block, in `Gate`) are smoothed per sample here, quick to open
 * and slow to close, so the sound never steps from one level to another.
 */
import { BLOCK, CLOSED_GAIN, Gate, LOOKAHEAD_BLOCKS } from './gate.ts';

// The audio thread's own globals, which the page's DOM typings do not have.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

const DELAY = LOOKAHEAD_BLOCKS * BLOCK;
const RING = DELAY + BLOCK;

class GateProcessor extends AudioWorkletProcessor {
  private readonly gate = new Gate();
  private readonly ring = new Float32Array(RING);
  private write = 0;
  private readonly block = new Float32Array(BLOCK);
  private filled = 0;
  private previous = 0;
  private sumSquares = 0;
  private sumChange = 0;
  private target = CLOSED_GAIN;
  private gain = CLOSED_GAIN;
  // Smoothing per sample: open in about 3 ms, close over about 80 ms.
  private readonly attack = 1 - Math.exp(-1 / (0.003 * sampleRate));
  private readonly release = 1 - Math.exp(-1 / (0.08 * sampleRate));

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    for (let i = 0; i < output.length; i++) {
      const x = input?.[i] ?? 0;
      // The newest sample in; the one from `DELAY` samples ago out.
      this.ring[this.write] = x;
      const old = this.ring[(this.write + RING - DELAY) % RING]!;
      this.write = (this.write + 1) % RING;
      const d = x - this.previous;
      this.previous = x;
      this.sumSquares += x * x;
      this.sumChange += d * d;
      if (++this.filled === BLOCK) {
        const rms = Math.sqrt(this.sumSquares / BLOCK);
        const brightness = this.sumSquares > 0 ? Math.sqrt(this.sumChange / this.sumSquares) : 0;
        this.target = this.gate.next(rms, brightness);
        this.filled = 0;
        this.sumSquares = 0;
        this.sumChange = 0;
      }
      this.gain +=
        (this.target - this.gain) * (this.target > this.gain ? this.attack : this.release);
      output[i] = old * this.gain;
    }
    return true;
  }
}

registerProcessor('intercom-gate', GateProcessor);

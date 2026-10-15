/**
 * The noise gate on the audio thread. It is built as a file of its own (`gate-worklet.js`, see
 * scripts/build.mjs) and loaded by `noise.ts`: a script processor ran on the page's main thread,
 * where a busy moment (video tiles, a whiteboard, recording) made the audio stutter, and a gap
 * in sound sent to others is heard as crackle.
 *
 * What goes out is `LOOKAHEAD_BLOCKS` blocks older than what comes in, so the gate can see a word
 * coming. All of the processing is in `GateProcessorCore` (gate.ts), which is what the tests run.
 */
import { GateProcessorCore } from './gate.ts';

// The audio thread's own globals, which the page's DOM typings do not have.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class GateProcessor extends AudioWorkletProcessor {
  private readonly core = new GateProcessorCore(sampleRate);

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (output) this.core.process(inputs[0]?.[0], output);
    return true;
  }
}

registerProcessor('intercom-gate', GateProcessor);

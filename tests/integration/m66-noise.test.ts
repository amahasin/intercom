import { describe, expect, it } from 'vitest';
import {
  BLOCK,
  Gate,
  GateProcessorCore,
  LOOKAHEAD_BLOCKS,
  micConstraints,
  periodicity,
} from '../../apps/desktop/renderer/src/calls/gate.ts';

/** A block's pitch measure when it is a voice, and when it is not (a click, a hiss). */
const VOICE = 0.8;

/** Feed blocks of a given level to the gate; returns the gain it ends on. */
function feed(gate: Gate, level: number, blocks: number, periodic: number | undefined = VOICE) {
  let gain = 0;
  for (let i = 0; i < blocks; i++)
    gain = gate.next(level * (1 + 0.1 * Math.sin(i)), 0.25, periodic);
  return gain;
}

describe('M6.6 noise suppression gate', () => {
  it('lets a near voice through and lowers the room, a far voice and keyboard taps', () => {
    const gate = new Gate();
    // The room alone (fan, hum): about -46 dBFS. The gate stays low.
    expect(feed(gate, 0.005, 300, 0)).toBeLessThan(0.1);
    // The user speaks, level about -22 dBFS: open at once.
    expect(feed(gate, 0.08, 40)).toBeGreaterThan(0.95);
    // Keep talking, and a colleague across the room (about -38 dBFS) is far below the voice.
    feed(gate, 0.08, 200);
    // The voice stops; after the hold the gate closes and a far voice stays down.
    feed(gate, 0.005, 60, 0);
    expect(feed(gate, 0.012, 100)).toBeLessThan(0.15);
    // The user speaks again after the pause: the gate reopens.
    expect(feed(gate, 0.08, 30)).toBeGreaterThan(0.9);
  });

  it('does not clip the end of a word (it holds for about half a second)', () => {
    const gate = new Gate();
    feed(gate, 0.005, 200, 0);
    feed(gate, 0.08, 100);
    // 300 ms of quiet after speech (about 28 blocks): still open.
    expect(feed(gate, 0.004, 28, 0)).toBeGreaterThan(0.9);
  });

  it('never locks out a quiet microphone: a voice at -44 dBFS or -50 dBFS opens it from the start', () => {
    for (const level of [0.006, 0.003]) {
      const gate = new Gate();
      // A very quiet room, then the user speaks at that level, in bursts like words.
      feed(gate, 0.0004, 100, 0);
      for (let word = 0; word < 6; word++) {
        let gain = 0;
        for (let i = 0; i < 40; i++)
          gain = gate.next(level * (1 + 0.15 * Math.sin(i)), 0.25, VOICE);
        // Open within the word, not only at its end.
        expect(gain).toBeGreaterThan(0.9);
        feed(gate, 0.0004, 70, 0);
      }
    }
  });

  it('learns again when the user turns away and gets quieter for good', () => {
    const gate = new Gate();
    // Words and the pauses between them, `level` loud, in a quiet room.
    const words = (level: number, count: number) => {
      const firstGains: number[] = [];
      for (let w = 0; w < count; w++) {
        for (let i = 0; i < 35; i++) {
          const gain = gate.next(level * (1 + 0.15 * Math.sin(i / 2)), 0.25, VOICE);
          if (i === 20) firstGains.push(gain);
        }
        for (let i = 0; i < 25; i++) gate.next(0.0004, 0.3, 0);
      }
      return firstGains;
    };
    feed(gate, 0.0004, 200, 0);
    // A normal voice for a while, then a long silence.
    words(0.08, 12);
    feed(gate, 0.0004, 400, 0);
    // The user turns 18 dB away from the microphone and keeps talking: the first words are lost...
    const afterTurn = words(0.01, 14);
    expect(afterTurn[0]).toBeLessThan(0.1);
    // ...then the quieter voice becomes the usual one, within a few words, and stays open.
    const firstOpen = afterTurn.findIndex((g) => g > 0.9);
    expect(firstOpen).toBeGreaterThan(-1);
    expect(firstOpen).toBeLessThan(6);
    expect(afterTurn.slice(firstOpen).every((g) => g > 0.9)).toBe(true);
  });

  it('keeps keyboard and mouse clicks out when nobody is talking', () => {
    const gate = new Gate();
    // Settle on a quiet room, and on the user's voice once.
    feed(gate, 0.005, 300, 0);
    feed(gate, 0.08, 60);
    feed(gate, 0.005, 120, 0);
    // A key press: a burst of one to three blocks, well above the room, broadband (bright).
    let loudest = 0;
    for (let tap = 0; tap < 20; tap++) {
      for (let i = 0; i < 3; i++) loudest = Math.max(loudest, gate.next(0.06, 1.2, 0.1));
      for (let i = 0; i < 20; i++) gate.next(0.005, 0.3, 0);
    }
    // Louder than the voice's own threshold, but never let through.
    expect(loudest).toBeLessThan(0.1);
    // A click that is short but not bright (a thud on the desk) is too short to open it.
    let thud = 0;
    for (let tap = 0; tap < 20; tap++) {
      for (let i = 0; i < 2; i++) thud = Math.max(thud, gate.next(0.06, 0.3, VOICE));
      for (let i = 0; i < 20; i++) gate.next(0.005, 0.3, 0);
    }
    expect(thud).toBeLessThan(0.1);
    // A longer thump that is not a voice (no pitch) is not one either.
    let thump = 0;
    for (let tap = 0; tap < 20; tap++) {
      for (let i = 0; i < 4; i++) thump = Math.max(thump, gate.next(0.06, 0.3, 0.1));
      for (let i = 0; i < 20; i++) gate.next(0.005, 0.3, 0);
    }
    expect(thump).toBeLessThan(0.1);
    // Speech (sustained, with a pitch) opens it.
    let gain = 0;
    for (let i = 0; i < 12; i++) gain = gate.next(0.08, 0.25, VOICE);
    expect(gain).toBeGreaterThan(0.9);
  });

  it('does not let clicks hold the gate open after speech has ended', () => {
    const gate = new Gate();
    feed(gate, 0.004, 200, 0);
    feed(gate, 0.08, 100);
    // Speech ends. A key press every 150 ms (about 14 blocks) goes on: it must not hold the gate.
    let gain = 1;
    for (let block = 0; block < 140; block++) {
      const click = block % 14 < 2;
      gain = gate.next(click ? 0.06 : 0.004, click ? 1.2 : 0.3, click ? 0.1 : 0);
    }
    expect(gain).toBeLessThan(0.1);
  });

  it('opens for a sound that goes on but has no pitch (an "s", a whisper), and not for a click', () => {
    const gate = new Gate();
    feed(gate, 0.004, 200, 0);
    feed(gate, 0.08, 100);
    // The gate closes after the hold, and fades down over a second or so.
    feed(gate, 0.004, 200, 0);
    // Four bright blocks (about 43 ms) are a click; five (about 53 ms) are the start of a fricative.
    let gain = 0;
    for (let i = 0; i < 4; i++) gain = gate.next(0.02, 1.2, 0.1);
    expect(gain).toBeLessThan(0.1);
    for (let i = 0; i < 20; i++) gate.next(0.004, 0.3, 0);
    for (let i = 0; i < 6; i++) gain = gate.next(0.02, 1.2, 0.1);
    expect(gain).toBeGreaterThan(0.5);
  });

  it('keeps a colleague who talks nearby out, but not the user', () => {
    const gate = new Gate();
    feed(gate, 0.005, 300, 0);
    // The user talks for a while: the gate learns how loud the user is.
    for (let i = 0; i < 300; i++) gate.next(0.1 * (1 + 0.2 * Math.sin(i / 3)), 0.25, VOICE);
    feed(gate, 0.005, 60, 0);
    // A colleague at a sixth of the loudness, speech-like: stays shut out.
    let gain = 0;
    for (let i = 0; i < 400; i++)
      gain = gate.next(0.017 * (1 + 0.3 * Math.sin(i / 4)), 0.25, VOICE);
    expect(gain).toBeLessThan(0.05);
    // The user speaks again: through.
    for (let i = 0; i < 20; i++) gain = gate.next(0.1, 0.25, VOICE);
    expect(gain).toBeGreaterThan(0.9);
  });

  it('does not lock the user out after one shout or a laugh', () => {
    const gate = new Gate();
    feed(gate, 0.005, 300, 0);
    for (let i = 0; i < 60; i++) gate.next(0.06, 0.25, VOICE);
    // A shout, then back to a normal voice a little quieter than before.
    for (let i = 0; i < 30; i++) gate.next(0.5, 0.25, VOICE);
    feed(gate, 0.005, 80, 0);
    let gain = 0;
    for (let i = 0; i < 40; i++) gain = gate.next(0.05, 0.25, VOICE);
    expect(gain).toBeGreaterThan(0.9);
  });

  it('closes by about 34 dB, never to nothing, and never steps', () => {
    const gate = new Gate();
    const gains: number[] = [];
    for (let i = 0; i < 200; i++) gains.push(gate.next(0.0005, 0, 0));
    expect(Math.min(...gains)).toBeGreaterThan(0.015);
    expect(Math.max(...gains)).toBeLessThan(0.03);
  });
});

describe('M6.6 what is a voice: pitch', () => {
  const LENGTH = 256 + 100;
  /** A buffer at 8 kHz of `f(i)`. */
  const buffer = (f: (i: number) => number) =>
    Float32Array.from({ length: LENGTH }, (_, i) => f(i));
  let seed = 7;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

  it('finds the pitch of a vowel, and none in noise or a click', () => {
    // A vowel: a 120 Hz source with a few harmonics (at 8 kHz sampling).
    const vowel = buffer((i) =>
      [1, 2, 3, 4, 5, 6].reduce(
        (sum, h) => sum + Math.sin((2 * Math.PI * 120 * h * i) / 8000) / h,
        0,
      ),
    );
    expect(periodicity(vowel)).toBeGreaterThan(0.85);
    // A higher voice too (300 Hz), and one with a changing pitch.
    expect(periodicity(buffer((i) => Math.sin((2 * Math.PI * 300 * i) / 8000)))).toBeGreaterThan(
      0.9,
    );
    expect(
      periodicity(buffer((i) => Math.sin((2 * Math.PI * (130 + i * 0.1) * i) / 8000))),
    ).toBeGreaterThan(0.6);
    // Hiss, and a click (a short decaying burst).
    expect(periodicity(buffer(() => noise()))).toBeLessThan(0.3);
    expect(periodicity(buffer((i) => (i < 20 ? noise() * Math.exp(-i / 5) : 0)))).toBeLessThan(0.4);
    // Silence.
    expect(periodicity(new Float32Array(LENGTH))).toBe(0);
  });
});

describe('M6.6 the processor that runs on the audio thread', () => {
  const FS = 48000;
  /** Run `samples` through the core in 128-sample quanta, as the audio thread does. */
  function run(core: GateProcessorCore, samples: Float32Array): Float32Array {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 128)
      core.process(samples.subarray(i, i + 128), out.subarray(i, i + 128));
    return out;
  }
  const rms = (x: Float32Array, from: number, to: number) => {
    let s = 0;
    for (let i = from; i < to; i++) s += x[i]! * x[i]!;
    return Math.sqrt(s / (to - from));
  };
  /** A vowel-like sound: a 120 Hz source with harmonics, shaped like speech, at `level` (RMS). */
  const vowel = (seconds: number, level: number) => {
    const x = new Float32Array(Math.floor(seconds * FS));
    for (let i = 0; i < x.length; i++)
      for (let h = 1; h <= 20; h++)
        x[i]! += Math.sin((2 * Math.PI * 120 * h * i) / FS) / (h * h * 0.5 + 1);
    const k = level / rms(x, 0, x.length);
    return x.map((v) => v * k);
  };
  let seed = 3;
  const noise = (n: number, level: number) =>
    Float32Array.from({ length: n }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return ((seed / 4294967296) * 2 - 1) * level * 1.7;
    });

  it('delays the sound by the look-ahead, and passes a voice of any level untouched', () => {
    for (const level of [0.1, 0.01, 0.004]) {
      const core = new GateProcessorCore(FS);
      expect(core.latency).toBe(LOOKAHEAD_BLOCKS * BLOCK);
      const input = new Float32Array(FS * 3);
      input.set(vowel(2, level), FS / 2);
      const out = run(core, input);
      // After the delay, the second half of the voice comes out at its own level.
      const from = FS + core.latency;
      expect(rms(out, from, from + FS / 2) / level).toBeGreaterThan(0.9);
      expect(rms(out, from, from + FS / 2) / level).toBeLessThan(1.1);
      // Before the voice starts there is nothing.
      expect(rms(out, 0, FS / 4)).toBe(0);
    }
  });

  it('lowers steady noise and clicks by a lot when nobody speaks', () => {
    const core = new GateProcessorCore(FS);
    // A voice first, so the gate knows the user; then a second of hiss and key presses.
    const input = new Float32Array(FS * 5);
    input.set(vowel(1, 0.05), 0);
    input.set(noise(FS * 2, 0.003), FS * 3);
    for (let at = FS * 3 + 4800; at < FS * 5 - 2000; at += 7200)
      for (let i = 0; i < 700; i++) input[at + i]! += (i % 2 ? 1 : -1) * 0.1 * Math.exp(-i / 150);
    const out = run(core, input);
    const from = FS * 4;
    const to = FS * 5 - 4000;
    const before = rms(input, from, to);
    const after = rms(out, from + core.latency, to + core.latency);
    expect(20 * Math.log10(before / Math.max(after, 1e-9))).toBeGreaterThan(15);
  });
});

describe('M6.6 microphone constraints', () => {
  it('asks the browser for what each level means', () => {
    expect(micConstraints('off')).toMatchObject({
      noiseSuppression: false,
      echoCancellation: false,
    });
    expect(micConstraints('standard')).toMatchObject({
      noiseSuppression: true,
      autoGainControl: true,
    });
    // High turns automatic gain off: it is what raises far-away sound to the level of a voice.
    expect(micConstraints('high')).toMatchObject({
      noiseSuppression: true,
      autoGainControl: false,
    });
    // Nothing is asked of the browser that is not known to be safe for the user's voice.
    expect(Object.keys(micConstraints('high')).sort()).toEqual([
      'autoGainControl',
      'echoCancellation',
      'noiseSuppression',
    ]);
  });
});

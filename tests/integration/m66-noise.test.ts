import { describe, expect, it } from 'vitest';
import {
  BLOCK,
  Gate,
  GateProcessorCore,
  limit,
  LOOKAHEAD_BLOCKS,
  MAKEUP_MAX,
  MAKEUP_PEAK,
  MAKEUP_TARGET,
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
  /** `vowel`, said as speech is: syllables of 170 ms with 80 ms of near silence between them. */
  const syllables = (seconds: number, level: number) => {
    // Harmonics that fall off slowly, as a voice's do (there is a good deal of it above 250 Hz).
    const x = new Float32Array(Math.floor(seconds * FS));
    for (let i = 0; i < x.length; i++) {
      const t = (i / FS) % 0.25;
      const edge = Math.min(1, t / 0.02, (0.17 - t) / 0.02);
      let v = 0;
      for (let h = 1; h <= 20; h++) v += Math.sin((2 * Math.PI * 120 * h * i) / FS) / (h * 0.5 + 1);
      x[i] = v * (t < 0.17 ? Math.max(0.08, edge) : 0.08);
    }
    const k = level / rms(x, 0, x.length);
    return x.map((v) => v * k);
  };
  let seed = 3;
  const noise = (n: number, level: number) =>
    Float32Array.from({ length: n }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return ((seed / 4294967296) * 2 - 1) * level * 1.7;
    });

  it('delays the sound by the look-ahead, and passes a voice that is loud enough untouched', () => {
    for (const level of [0.1, 0.2]) {
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

  it('brings a quiet voice up to the usual level, and no further than it can safely', () => {
    // -36 dBFS: what the browser leaves of a voice after it has taken the noise off. Raised to
    // the target, not left as the colleague's "low sound". (A window of syllables has the pauses
    // between them in it: about a sixth of it, so the level to meet is a little under the target.)
    const quiet = new GateProcessorCore(FS);
    const input = new Float32Array(FS * 8);
    input.set(syllables(7, 0.015), FS / 2);
    const out = run(quiet, input);
    const last = FS * 7;
    expect(rms(out, last + quiet.latency, last + quiet.latency + FS / 2)).toBeGreaterThan(
      MAKEUP_TARGET * 0.7,
    );
    expect(rms(out, last + quiet.latency, last + quiet.latency + FS / 2)).toBeLessThan(
      MAKEUP_TARGET * 1.15,
    );
    // A voice far quieter than that is raised by the most allowed (+18 dB), not more.
    const faint = new GateProcessorCore(FS);
    const faintInput = new Float32Array(FS * 8);
    faintInput.set(syllables(7, 0.004), FS / 2);
    const faintOut = run(faint, faintInput);
    const gain = rms(faintOut, last + faint.latency, last + faint.latency + FS / 2) / 0.004;
    expect(gain).toBeGreaterThan(MAKEUP_MAX * 0.85);
    expect(gain).toBeLessThan(MAKEUP_MAX * 1.15);
  });

  it('does not raise the noise it holds down, and does not let a shout clip', () => {
    const core = new GateProcessorCore(FS);
    // A quiet voice for a while (so the gate is raising it), then only a steady hiss.
    const input = new Float32Array(FS * 10);
    input.set(vowel(5, 0.01), 0);
    input.set(noise(FS * 5, 0.002), FS * 5);
    const out = run(core, input);
    const from = FS * 8;
    const to = FS * 10 - 4000;
    // The hiss is still lowered by well over 15 dB, though the voice before it was raised.
    expect(
      20 *
        Math.log10(
          rms(input, from, to) / Math.max(rms(out, from + core.latency, to + core.latency), 1e-9),
        ),
    ).toBeGreaterThan(15);
    // A voice that has been raised, then a shout 20 dB louder: the output stays inside full scale.
    const loud = new GateProcessorCore(FS);
    const shout = new Float32Array(FS * 8);
    shout.set(vowel(5, 0.01), 0);
    shout.set(vowel(3, 0.1), FS * 5);
    const shouted = run(loud, shout);
    let peak = 0;
    for (const v of shouted) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(1);
    expect(limit(0.5)).toBe(0.5);
    expect(limit(5)).toBeLessThan(1);
    expect(limit(-5)).toBeGreaterThan(-1);
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

describe('M6.24 a voice in a loud room, a hum, and a leveler that was told the wrong level', () => {
  const FS = 48000;
  const rms = (x: Float32Array, from: number, to: number) => {
    let s = 0;
    for (let i = from; i < to; i++) s += x[i]! * x[i]!;
    return Math.sqrt(s / (to - from));
  };
  const vowel = (seconds: number, level: number) => {
    const x = new Float32Array(Math.floor(seconds * FS));
    for (let i = 0; i < x.length; i++)
      for (let h = 1; h <= 20; h++)
        x[i]! += Math.sin((2 * Math.PI * 120 * h * i) / FS) / (h * h * 0.5 + 1);
    const k = level / rms(x, 0, x.length);
    return x.map((v) => v * k);
  };
  /** `vowel`, said as speech is: syllables of 170 ms with 80 ms of near silence between them. */
  const syllables = (seconds: number, level: number) => {
    // Harmonics that fall off slowly, as a voice's do (there is a good deal of it above 250 Hz).
    const x = new Float32Array(Math.floor(seconds * FS));
    for (let i = 0; i < x.length; i++) {
      const t = (i / FS) % 0.25;
      const edge = Math.min(1, t / 0.02, (0.17 - t) / 0.02);
      let v = 0;
      for (let h = 1; h <= 20; h++) v += Math.sin((2 * Math.PI * 120 * h * i) / FS) / (h * 0.5 + 1);
      x[i] = v * (t < 0.17 ? Math.max(0.08, edge) : 0.08);
    }
    const k = level / rms(x, 0, x.length);
    return x.map((v) => v * k);
  };
  /** Run `samples` through `core` as the audio thread does; what it raises, at the end of each quantum. */
  const track = (core: GateProcessorCore, samples: Float32Array) => {
    const out = new Float32Array(samples.length);
    const applied: number[] = [];
    for (let i = 0; i < samples.length; i += 128) {
      core.process(samples.subarray(i, i + 128), out.subarray(i, i + 128));
      applied.push(core.applied);
    }
    return { out, applied };
  };

  it('opens for a voice only 4 dB above a loud steady room, and shuts again for the room alone', () => {
    const gate = new Gate();
    // The room (-34 dBFS, no pitch, bright like hiss): the gate stays shut.
    let gain = 0;
    for (let i = 0; i < 400; i++) gain = gate.next(0.02 * (1 + 0.1 * Math.sin(i * 1.3)), 0.8, 0.15);
    expect(gain).toBeLessThan(0.1);
    // The user speaks at 0.032 (4 dB above it) with a clear pitch: open within the word, and open
    // all through it (more than 5 seconds of it, in words, with the dips of speech between).
    const words = (blocks: number) => {
      const opened: number[] = [];
      for (let i = 0; i < blocks; i++) {
        const dip = i % 25 > 21; // between syllables
        opened.push(
          gate.next(
            dip ? 0.022 : 0.032 * (1 + 0.15 * Math.sin(i)),
            dip ? 0.7 : 0.3,
            dip ? 0.15 : 0.8,
          ),
        );
      }
      return opened;
    };
    const spoken = words(500);
    expect(spoken[40]).toBeGreaterThan(0.9);
    expect(spoken.slice(40).filter((g) => g < 0.9).length).toBe(0);
    // The room alone again: closed after the hold.
    for (let i = 0; i < 100; i++) gain = gate.next(0.02 * (1 + 0.1 * Math.sin(i * 1.3)), 0.8, 0.15);
    expect(gain).toBeLessThan(0.15);
  });

  it('does not open for sound as loud as that voice when it has no clear pitch', () => {
    const gate = new Gate();
    for (let i = 0; i < 400; i++) gate.next(0.02, 0.8, 0.15);
    // A colleague's murmur, a rustle or a passing lorry: as loud as the voice, with a weak pitch.
    let loudest = 0;
    for (let i = 0; i < 400; i++)
      loudest = Math.max(loudest, gate.next(0.032 * (1 + 0.2 * Math.sin(i)), 0.6, 0.3));
    expect(loudest).toBeLessThan(0.1);
  });

  it('shuts out a steady hum that starts in a quiet room within about ten seconds', () => {
    const gate = new Gate();
    for (let i = 0; i < 300; i++) gate.next(0.0006, 0.3, 0);
    // A hum with a clear pitch and a steady level (what speech never has).
    let closedAt = -1;
    for (let i = 0; i < 3000; i++) {
      const gain = gate.next(0.03 * (1 + 0.02 * Math.sin(i / 7)), 0.3, 0.9);
      if (i > 20 && gain < 0.1) {
        closedAt = i;
        break;
      }
    }
    expect(closedAt).toBeGreaterThan(0);
    // At 48 kHz a block is 512 samples: 10 seconds is about 940 blocks.
    expect(closedAt).toBeLessThan(940);
  });

  it('does not raise a voice past the ceiling when what it learned was a quieter voice', () => {
    const core = new GateProcessorCore(FS);
    // A colleague close by talks for 8 seconds first (the gate takes them for the user), then the
    // user, 16 dB louder.
    const colleague = syllables(8, 0.008);
    const user = syllables(6, 0.05);
    const input = new Float32Array(FS * 14);
    input.set(colleague, 0);
    input.set(user, colleague.length);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i += 128)
      core.process(input.subarray(i, i + 128), out.subarray(i, i + 128));
    // The user's last second: not above the ceiling (a little over, for the way it is reached).
    const from = FS * 13 + core.latency;
    expect(rms(out, from, from + FS / 2)).toBeLessThan(MAKEUP_PEAK * 1.2);
    // And still lifted (the ceiling is not a cut): louder than it went in.
    expect(rms(out, from, from + FS / 2)).toBeGreaterThan(0.05);
    expect(MAKEUP_PEAK).toBeLessThan(MAKEUP_TARGET * 2);
  });

  it('raises speech, but not a steady tone that goes on as loud as the voice (music, a hum)', () => {
    const core = new GateProcessorCore(FS);
    const { applied } = track(core, syllables(6, 0.02));
    // Speech: sure of it within a second, and it stays so.
    expect(Math.max(...applied.slice(0, (FS * 1.5) / 128))).toBeGreaterThan(0.95);
    expect(applied.at(-1)).toBeGreaterThan(0.95);
    // The same sound without the syllables (nothing moves): no longer raised within two seconds.
    const steady = track(core, vowel(3, 0.02));
    expect(steady.applied.at(-1)).toBe(0);
  });

  it('does not raise a door, whatever it learned a moment ago: a thud has no speech in it', () => {
    const core = new GateProcessorCore(FS);
    const speech = syllables(6, 0.02);
    const quiet = new Float32Array(FS * 2);
    // A thud: two low resonances, decaying over 300 ms, about as loud as the voice.
    const thud = Float32Array.from({ length: Math.floor(FS * 0.5) }, (_, i) => {
      const t = i / FS;
      return (
        0.05 *
        Math.exp(-t / 0.08) *
        (Math.sin(2 * Math.PI * 90 * t) + 0.6 * Math.sin(2 * Math.PI * 150 * t))
      );
    });
    const input = new Float32Array(speech.length + quiet.length + thud.length);
    input.set(speech, 0);
    input.set(thud, speech.length + quiet.length);
    const { applied } = track(core, input);
    // Sure of the voice at the end of the speech.
    expect(applied[Math.floor(speech.length / 128) - 1]).toBeGreaterThan(0.95);
    // Not raised at any time while the thud is there (the gate may open for it).
    const during = applied.slice(Math.floor((speech.length + quiet.length) / 128));
    expect(Math.max(...during)).toBeLessThan(0.05);
  });

  it('does not take rumble for a voice by its pitch alone, and a deep voice is still heard', () => {
    // 0.05 is well over a quiet room, with a clear pitch (0.9), not bright: a voice, but for the
    // share of it that is below 250 Hz.
    const rumble = new Gate();
    for (let i = 0; i < 200; i++) rumble.next(0.002, 0.3, 0, 0.1);
    let gain = 0;
    for (let i = 0; i < 4; i++) gain = rumble.next(0.05, 0.1, 0.9, 0.95);
    expect(gain).toBeLessThan(0.3);
    const voice = new Gate();
    for (let i = 0; i < 200; i++) voice.next(0.002, 0.3, 0, 0.1);
    for (let i = 0; i < 4; i++) gain = voice.next(0.05, 0.1, 0.9, 0.4);
    expect(gain).toBeGreaterThan(0.5);
    // A deep voice whose energy is mostly below 250 Hz is not shut out: sound that goes on opens it.
    const deep = new Gate();
    for (let i = 0; i < 200; i++) deep.next(0.002, 0.3, 0, 0.1);
    for (let i = 0; i < 12; i++) gain = deep.next(0.05, 0.1, 0.9, 0.95);
    expect(gain).toBeGreaterThan(0.5);
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

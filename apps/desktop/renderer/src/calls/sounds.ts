/**
 * The sounds of a call. Two are recordings: the ringtone for the person being called
 * (`ringtone.mp3`) and the tune the caller hears while waiting (`ringback.mp3`); see LICENSE for
 * where they are from. A tune made on the fly with Web Audio takes the place of either if its file
 * cannot be decoded. The rest are made the same way: the call-waiting pings and a short cue when
 * a call connects or ends, soft sine and triangle tones with a quick decay and a light echo, so
 * they sound like chimes rather than beeps. They play on the speaker chosen in Settings, like the
 * call itself.
 */
import { useApp } from '../state.ts';

export type LoopName = 'ringtone' | 'ringback' | 'waiting';

/**
 * The loops that are recordings. `gapSeconds` is the quiet between one play and the next, `gain`
 * evens out how loud the file was recorded.
 */
const RECORDINGS: Partial<Record<LoopName, { url: string; gapSeconds: number; gain: number }>> = {
  // 4 times the same run of 8 bell notes (about 7.8 s).
  ringtone: { url: new URL('./ringtone.mp3', import.meta.url).href, gapSeconds: 1.2, gain: 1 },
  // A steady 420 Hz ring of 1.1 s, a phone's "it is ringing": about 1 s on, 3 s off.
  ringback: { url: new URL('./ringback.mp3', import.meta.url).href, gapSeconds: 2.9, gain: 0.6 },
};
export type CueName = 'connected' | 'ended' | 'missed' | 'declined' | 'unavailable';

/** What was played, newest last: lets tests (and a curious developer) see the sounds. */
export const soundLog: string[] = [];

let context: AudioContext | undefined;
let sink: { id: string; el: HTMLAudioElement; dest: MediaStreamAudioDestinationNode } | undefined;

function audio(): AudioContext {
  context ??= new AudioContext();
  void context.resume().catch(() => {});
  return context;
}

/** The chosen speaker (Settings > Calls and devices), else the Windows default. */
function output(c: AudioContext): AudioNode {
  const id = useApp.getState().settings?.audioOutput ?? '';
  if (!id || id === 'default') {
    sink?.el.pause();
    sink = undefined;
    return c.destination;
  }
  if (sink?.id !== id) {
    sink?.el.pause();
    const dest = c.createMediaStreamDestination();
    const el = new Audio();
    el.srcObject = dest.stream;
    void (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
      .setSinkId?.(id)
      .catch(() => {});
    void el.play().catch(() => {});
    sink = { id, el, dest };
  }
  return sink.dest;
}

interface Bus {
  input: GainNode;
  /** Fade out and let go (the echo's tail finishes under the fade). */
  release(afterMs?: number): void;
}

/** A dry path plus a soft echo (not for a recording, which has its own), into the speaker. */
function bus(c: AudioContext, level: number, echo = true): Bus {
  const input = c.createGain();
  const master = c.createGain();
  master.gain.value = level;
  const dry = c.createGain();
  dry.gain.value = echo ? 0.85 : 1;
  input.connect(dry).connect(master);
  if (echo) {
    const delay = c.createDelay(1);
    delay.delayTime.value = 0.21;
    const feedback = c.createGain();
    feedback.gain.value = 0.34;
    const wet = c.createGain();
    wet.gain.value = 0.32;
    const soften = c.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 4200;
    input.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(soften).connect(master);
  }
  master.connect(output(c));
  return {
    input,
    release(afterMs = 1800) {
      master.gain.setTargetAtTime(0, c.currentTime, 0.03);
      window.setTimeout(() => master.disconnect(), afterMs);
    },
  };
}

interface NoteOptions {
  gain?: number;
  type?: OscillatorType;
  /** Overtones as [frequency ratio, loudness]: what makes a note bell-like or mellow. */
  partials?: Array<[number, number]>;
  attack?: number;
}

const BELL: Array<[number, number]> = [
  [1, 1],
  [2, 0.26],
  [3, 0.09],
  [4.2, 0.04],
];
const MELLOW: Array<[number, number]> = [
  [1, 1],
  [2, 0.12],
];

function note(
  c: AudioContext,
  out: AudioNode,
  freq: number,
  at: number,
  dur: number,
  o: NoteOptions = {},
): void {
  const env = c.createGain();
  env.connect(out);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(o.gain ?? 0.2, at + (o.attack ?? 0.008));
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  for (const [ratio, loudness] of o.partials ?? BELL) {
    const osc = c.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.value = freq * ratio;
    const g = c.createGain();
    g.gain.value = loudness;
    osc.connect(g).connect(env);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }
}

// Pitches (Hz).
const D4 = 293.66;
const F4 = 349.23;
const A4 = 440;
const B4 = 493.88;
const C5 = 523.25;
const E5 = 659.25;
const FS5 = 739.99;
const G5 = 783.99;
const A5 = 880;
const C6 = 1046.5;

/** Ringtone: a short music-box tune in C major pentatonic, then a pause. */
function ringtoneCycle(c: AudioContext, out: AudioNode, t: number): void {
  const tune: Array<[number, number, number]> = [
    [G5, 0, 0.5],
    [E5, 0.22, 0.5],
    [A5, 0.44, 0.5],
    [G5, 0.66, 0.5],
    [C6, 0.98, 0.9],
    [A5, 1.32, 0.6],
    [G5, 1.56, 0.6],
    [E5, 1.82, 1.5],
  ];
  for (const [f, at, dur] of tune) note(c, out, f, t + at, dur, { gain: 0.2 });
}

/** Ringback: two slow, warm chords, like a doorbell heard from the next room. */
function ringbackCycle(c: AudioContext, out: AudioNode, t: number): void {
  const chord = (freqs: number[], at: number) => {
    for (const f of freqs)
      note(c, out, f, t + at, 1.5, {
        gain: 0.1,
        type: 'triangle',
        partials: MELLOW,
        attack: 0.14,
      });
  };
  chord([A4, E5, A5], 0);
  chord([B4, FS5, 987.77], 0.8);
}

/** Call waiting: two quiet pings, so a second call is noticed without drowning the first. */
function waitingCycle(c: AudioContext, out: AudioNode, t: number): void {
  note(c, out, E5, t, 0.45, { gain: 0.1, type: 'triangle', partials: MELLOW });
  note(c, out, G5, t + 0.28, 0.6, { gain: 0.1, type: 'triangle', partials: MELLOW });
}

const LOOPS: Record<LoopName, { cycleSeconds: number; level: number; play: typeof ringtoneCycle }> =
  {
    ringtone: { cycleSeconds: 4.2, level: 0.9, play: ringtoneCycle },
    ringback: { cycleSeconds: 4.4, level: 0.8, play: ringbackCycle },
    waiting: { cycleSeconds: 3.6, level: 0.6, play: waitingCycle },
  };

const running = new Map<LoopName, () => void>();

const decoded = new Map<LoopName, Promise<AudioBuffer | undefined>>();

/** A recording, read and decoded once; `undefined` if it cannot be (the tune takes over). */
function loadRecording(c: AudioContext, name: LoopName): Promise<AudioBuffer | undefined> {
  const file = RECORDINGS[name];
  if (!file) return Promise.resolve(undefined);
  let buffer = decoded.get(name);
  if (!buffer) {
    buffer = fetch(file.url)
      .then((r) => r.arrayBuffer())
      .then((bytes) => c.decodeAudioData(bytes))
      .catch(() => undefined);
    decoded.set(name, buffer);
  }
  return buffer;
}

/** Start a looping sound (it plays until `stopLoop`). Starting one that is playing does nothing. */
export function startLoop(name: LoopName): void {
  if (running.has(name)) return;
  const c = audio();
  const spec = LOOPS[name];
  const file = RECORDINGS[name];
  // A recording carries its own space; the tunes made here get the soft echo.
  const b = bus(c, spec.level, !file);
  let nextAt = c.currentTime + 0.05;
  let stopped = false;
  let ready = !file;
  let sample: AudioBuffer | undefined;
  const schedule = () => {
    if (!ready) return;
    // Keep one cycle scheduled ahead on the audio clock, so the rhythm never drifts.
    while (nextAt < c.currentTime + 1.5) {
      if (sample && file) {
        const source = c.createBufferSource();
        source.buffer = sample;
        const gain = c.createGain();
        gain.gain.value = file.gain;
        source.connect(gain).connect(b.input);
        source.start(nextAt);
        nextAt += sample.duration + file.gapSeconds;
      } else {
        spec.play(c, b.input, nextAt);
        nextAt += spec.cycleSeconds;
      }
    }
  };
  if (file) {
    // The file is read and decoded the first time (a few milliseconds); the sound starts then.
    void loadRecording(c, name).then((buffer) => {
      if (stopped) return;
      sample = buffer;
      soundLog.push(`${name}:${buffer ? 'recording' : 'tune'}`);
      ready = true;
      nextAt = c.currentTime + 0.02;
      schedule();
    });
  }
  schedule();
  const timer = window.setInterval(schedule, 500);
  soundLog.push(`start:${name}`);
  running.set(name, () => {
    stopped = true;
    window.clearInterval(timer);
    b.release();
  });
}

export function stopLoop(name: LoopName): void {
  const stop = running.get(name);
  if (!stop) return;
  running.delete(name);
  stop();
  soundLog.push(`stop:${name}`);
}

/** Start or stop a loop to match `on`. */
export function syncLoop(name: LoopName, on: boolean): void {
  if (on) startLoop(name);
  else stopLoop(name);
}

/** A single short sound: the call connected, ended, was missed, declined or could not connect. */
export function playCue(name: CueName): void {
  const c = audio();
  const b = bus(c, 0.85);
  const t = c.currentTime + 0.03;
  switch (name) {
    case 'connected':
      note(c, b.input, C5, t, 0.5, { gain: 0.16 });
      note(c, b.input, G5, t + 0.12, 0.7, { gain: 0.16 });
      break;
    case 'ended':
      // Two soft notes stepping down: a full stop.
      note(c, b.input, E5, t, 0.55, { gain: 0.17 });
      note(c, b.input, B4, t + 0.17, 0.8, { gain: 0.17 });
      break;
    case 'missed':
      // Three notes sinking, a little wistful.
      note(c, b.input, A4, t, 0.6, { gain: 0.15, type: 'triangle', partials: MELLOW });
      note(c, b.input, F4, t + 0.2, 0.6, { gain: 0.15, type: 'triangle', partials: MELLOW });
      note(c, b.input, D4, t + 0.4, 1, { gain: 0.15, type: 'triangle', partials: MELLOW });
      break;
    case 'declined':
      note(c, b.input, D4 * 1.5, t, 0.3, { gain: 0.15, partials: MELLOW });
      note(c, b.input, D4 * 1.5, t + 0.2, 0.5, { gain: 0.15, partials: MELLOW });
      break;
    case 'unavailable':
      // Two short, low pulses: nobody to talk to right now.
      for (const at of [0, 0.34])
        note(c, b.input, 440, t + at, 0.26, {
          gain: 0.14,
          type: 'triangle',
          partials: MELLOW,
          attack: 0.02,
        });
      break;
  }
  soundLog.push(`play:${name}`);
  b.release(2200);
}

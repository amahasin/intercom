// Measures the call noise gate (apps/desktop/renderer/src/calls/gate.ts) on real speech.
//
//   node tools/scripts/check-noise.mjs
//
// Needs Windows (its text-to-speech voices make the speech: "David" is the user and "Zira" a
// colleague) and ffmpeg (on the path, or from `winget install Gyan.FFmpeg`). Nothing is recorded
// or stored: the speech is made in a temporary folder and removed. Each scenario prints what the
// gate did, and the script fails if it cost the user their voice or let the unwanted through:
//
//  - the user alone, at microphone levels from -20 to -50 dBFS: nothing of the voice may be lost,
//    and it must go out at a usable level (a quiet microphone is brought up, a loud one left alone);
//  - key presses and mouse clicks, steady room noise, and a quiet colleague nearby, in the pauses;
//  - the user turning away from the microphone (18 dB quieter): recovers within a sentence or two;
//  - a loud room (the voice only 4 to 6 dB above it): the voice is not cut, as the voice is judged
//    against the room while it talks (not only the pauses);
//  - typing and clicks while the user talks: the voice must not come out worse than it went in;
//  - a colleague close by who talks before the user: the user is not made too loud by the leveler.
//  - doors, clapping, typing and music from a phone, in the pauses: what gets through the gate is not
//    raised along with the voice (the leveler raises speech only), and most of it is kept out.
//
// The levels are "active speech level", the RMS of the loud parts of the voice. Exit code 0: all passed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gateUrl = pathToFileURL(
  resolve(here, '..', '..', 'apps', 'desktop', 'renderer', 'src', 'calls', 'gate.ts'),
).href;
const { GateProcessorCore } = await import(gateUrl);
const FS = 48000;
const FRAME = 960; // 20 ms

// ---------------------------------------------------------------- the test speech ----
function findFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    // Not on the path: look where winget puts it.
  }
  const root = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (!existsSync(root)) return undefined;
  for (const pkg of readdirSync(root).filter((n) => n.startsWith('Gyan.FFmpeg'))) {
    const base = join(root, pkg);
    for (const build of readdirSync(base)) {
      const exe = join(base, build, 'bin', 'ffmpeg.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

function makeSpeech(dir) {
  const ffmpeg = findFfmpeg();
  if (process.platform !== 'win32' || !ffmpeg) {
    console.error('check-noise: needs Windows (text-to-speech voices) and ffmpeg');
    process.exit(2);
  }
  const script = `
    Add-Type -AssemblyName System.Speech
    function Speak($voice, $text, $name, $rate) {
      $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
      $s.SelectVoice($voice); $s.Rate = $rate
      $s.SetOutputToWaveFile((Join-Path '${dir.replaceAll("'", "''")}' "$name.wav"))
      $s.Speak($text); $s.Dispose()
    }
    $installed = (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
    if (($installed -notcontains 'Microsoft David Desktop') -or ($installed -notcontains 'Microsoft Zira Desktop')) { exit 3 }
    Speak 'Microsoft David Desktop' 'She sells seashells by the seashore. Six slippery fish swam past the first ship. Please check the structural drawings for the steel support, and send me the final schedule. Thank you, see you at three o''clock in the big room. Yes, that is fine, I will set it up this afternoon.' 'user' 0
    Speak 'Microsoft Zira Desktop' 'Did you get the quarterly figures from the finance team? They said they would arrive on Thursday, but nothing has come through yet. Let me know if you need anything else before the meeting starts.' 'colleague' 1`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
    });
  } catch {
    console.error('check-noise: the Windows voices "David" and "Zira" are needed (English, US)');
    process.exit(2);
  }
  for (const name of ['user', 'colleague'])
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        join(dir, `${name}.wav`),
        '-ar',
        String(FS),
        '-ac',
        '1',
        '-f',
        'f32le',
        join(dir, `${name}.f32`),
      ],
      { stdio: 'ignore' },
    );
}

const load = (dir, name) => {
  const b = readFileSync(join(dir, `${name}.f32`));
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice();
};

// ------------------------------------------------------------------- the signals ----
const nFrames = (x) => Math.floor(x.length / FRAME);
const rmsOf = (x, f) => {
  let s = 0;
  for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / FRAME);
};
const db = (v) => 20 * Math.log10(Math.max(v, 1e-9));

function activeLevel(x) {
  const r = Array.from({ length: nFrames(x) }, (_, f) => rmsOf(x, f));
  const peak = Math.max(...r);
  let sum = 0;
  let count = 0;
  for (const v of r) {
    if (v <= peak * 0.1) continue;
    sum += v * v;
    count++;
  }
  return Math.sqrt(sum / count);
}
const scaleTo = (x, dbfs) => {
  const k = Math.pow(10, dbfs / 20) / activeLevel(x);
  return x.map((v) => v * k);
};

/** Cut the voice at its pauses (300 ms of near silence) into sentences. */
function sentences(x) {
  const r = Array.from({ length: nFrames(x) }, (_, f) => rmsOf(x, f));
  const quiet = Math.max(...r) * 0.02;
  const out = [];
  let start = null;
  let silent = 0;
  for (let f = 0; f < r.length; f++) {
    if (r[f] > quiet) {
      if (start === null) start = f;
      silent = 0;
    } else if (start !== null && ++silent >= 15) {
      out.push([start, f - silent + 1]);
      start = null;
      silent = 0;
    }
  }
  if (start !== null) out.push([start, r.length]);
  return out.map(([a, b]) =>
    x.slice(Math.max(0, a - 3) * FRAME, Math.min(r.length, b + 3) * FRAME),
  );
}

/** The voice's sentences with `gap` seconds of silence between them (and before the first). */
function compose(parts, gap, levels) {
  const pad = Math.floor(gap * FS);
  const length = parts.reduce((t, p) => t + p.length + pad, pad);
  const clean = new Float32Array(length);
  const spans = [];
  let at = pad;
  parts.forEach((p, i) => {
    clean.set(levels ? scaleTo(p, levels(i)) : p, at);
    spans.push([at, at + p.length]);
    at += p.length + pad;
  });
  return { clean, spans, length };
}

/** Frames well inside a silence: 0.7 s after the voice, and not in the last 100 ms before it. */
function silentFrames(spans, length) {
  const keep = new Array(Math.floor(length / FRAME)).fill(false);
  let prevEnd = 0;
  for (const [s0, e0] of [...spans, [length, length]]) {
    for (
      let f = Math.ceil((prevEnd + 0.7 * FS) / FRAME);
      f < Math.floor((s0 - 0.1 * FS) / FRAME);
      f++
    )
      keep[f] = true;
    prevEnd = e0;
  }
  return keep;
}

function noise(n, dbfs, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const x = new Float32Array(n);
  let b0 = 0,
    b1 = 0,
    b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    x[i] = b0 + b1 + b2 + w * 0.1848; // pink
  }
  return scaleTo(x, dbfs);
}

/** Key presses and mouse clicks: a short broadband burst with a decaying thump. */
function clicks(n, perSecond, peakDb, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const x = new Float32Array(n);
  for (let k = 0; k < Math.floor((n / FS) * perSecond); k++) {
    const at = Math.floor(rnd() * (n - FS / 5));
    const amp = Math.pow(10, peakDb / 20) * (0.5 + 0.5 * rnd());
    const len = Math.floor(FS * (0.012 + 0.02 * rnd()));
    const thump = 140 + 120 * rnd();
    for (let i = 0; i < len; i++)
      x[at + i] +=
        amp *
        Math.exp((-6 * i) / len) *
        (0.6 * (rnd() * 2 - 1) + 0.4 * Math.sin((2 * Math.PI * thump * i) / FS));
  }
  return x;
}

const mix = (...parts) => {
  const o = new Float32Array(Math.max(...parts.map((p) => p.length)));
  for (const p of parts) for (let i = 0; i < p.length; i++) o[i] += p[i];
  return o;
};

// --------------------------------------------------------------------- the gate ----
/** What the audio thread does: the 100 Hz high-pass, then the gate, in 128-sample quanta. */
function throughGate(input) {
  const core = new GateProcessorCore(FS);
  const hp = new Float32Array(input.length);
  const a = Math.exp((-2 * Math.PI * 100) / FS);
  let pi = 0,
    po = 0;
  for (let i = 0; i < input.length; i++) {
    const x = a * (po + input[i] - pi);
    pi = input[i];
    po = x;
    hp[i] = x;
  }
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 128)
    core.process(hp.subarray(i, i + 128), out.subarray(i, i + 128));
  return { out, delay: core.latency };
}
const aligned = (r, length) => {
  const x = new Float32Array(length);
  for (let i = 0; i + r.delay < r.out.length && i < length; i++) x[i] = r.out[i + r.delay];
  return x;
};

/** How the gate treated the user's voice, frame by frame, against the clean voice. */
function speechReport(clean, r) {
  const out = aligned(r, clean.length);
  const rs = Array.from({ length: nFrames(clean) }, (_, f) => rmsOf(clean, f));
  const peak = Math.max(...rs);
  let kept = 0,
    total = 0,
    count = 0,
    cut10 = 0;
  rs.forEach((a, f) => {
    if (a <= peak * 0.12) return;
    const b = rmsOf(out, f);
    kept += b * b;
    total += a * a;
    count++;
    if (db(b) - db(a) < -10) cut10++;
  });
  return { lossDb: 10 * Math.log10(kept / total), cut10: (100 * cut10) / count };
}

/**
 * How much of `unwanted` was removed in the silent frames, as heard against the user's voice: the
 * voice itself is raised by the leveler (`lift` dB, 0 or more), and so is what the gate lets through
 * while it is open, so what counts is how far below the voice the unwanted sound ended up.
 */
function removedDb(unwanted, r, keep, lift = 0) {
  const out = aligned(r, unwanted.length);
  let inE = 0,
    outE = 0;
  keep.forEach((k, f) => {
    if (!k) return;
    inE += rmsOf(unwanted, f) ** 2;
    outE += rmsOf(out, f) ** 2;
  });
  return 10 * Math.log10(inE / Math.max(outE, 1e-18)) + Math.max(0, lift);
}

/** The 100 Hz high-pass that starts the chain (see `throughGate`), for judging the voice fairly. */
function highpass(input) {
  const hp = new Float32Array(input.length);
  const a = Math.exp((-2 * Math.PI * 100) / FS);
  let pi = 0,
    po = 0;
  for (let i = 0; i < input.length; i++) {
    const x = a * (po + input[i] - pi);
    pi = input[i];
    po = x;
    hp[i] = x;
  }
  return hp;
}

/** The frames where the clean voice is speaking (the loud ones). */
function speechFrames(clean) {
  const rs = Array.from({ length: nFrames(clean) }, (_, f) => rmsOf(clean, f));
  const peak = Math.max(...rs);
  return rs.map((a, f) => (a > peak * 0.12 ? f : -1)).filter((f) => f >= 0);
}

/**
 * The speech frames after the first 0.4 s of each sentence. The leveler raises only sound that has
 * shown itself to be speech (a vowel's length of it), so a sentence that follows a pause starts at
 * the level it came in at until the vowel (a fricative at the start of it is not raised): that soft
 * start is the price of not raising a key press or a door, and it is not what "does the voice come
 * out worse for the noise in it" is about.
 */
function settledFrames(frames) {
  const out = [];
  let from = -1000;
  let last = -1000;
  for (const f of frames) {
    if (f - last > 25) from = f;
    last = f;
    if (f - from >= 20) out.push(f);
  }
  return out;
}

/**
 * How the voice came out, against the clean voice (which has had the same high-pass): the signal to
 * what else is in it (with the best gain for each half second, so the leveler moving slowly is not
 * counted as noise), the mean gain in dB, and the share of frames cut by more than 10 dB.
 */
function voiceQuality(reference, out, frames) {
  const groups = new Map();
  for (const f of frames) {
    const k = Math.floor(f / 25);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  let sig = 0,
    err = 0,
    cut = 0,
    gainSum = 0;
  for (const list of groups.values()) {
    let num = 0,
      den = 0;
    for (const f of list)
      for (let i = f * FRAME; i < (f + 1) * FRAME; i++) {
        num += out[i] * reference[i];
        den += reference[i] * reference[i];
      }
    const g = num / den;
    gainSum += 20 * Math.log10(Math.max(Math.abs(g), 1e-6)) * list.length;
    for (const f of list) {
      let a = 0,
        e = 0,
        o = 0;
      for (let i = f * FRAME; i < (f + 1) * FRAME; i++) {
        a += (g * reference[i]) ** 2;
        e += (out[i] - g * reference[i]) ** 2;
        o += out[i] ** 2;
      }
      sig += a;
      err += e;
      if (10 * Math.log10(Math.max(o, 1e-18) / Math.max(a, 1e-18)) < -10) cut++;
    }
  }
  return {
    snr: 10 * Math.log10(sig / Math.max(err, 1e-18)),
    gainDb: gainSum / frames.length,
    cut: (100 * cut) / frames.length,
  };
}

/** The signal-to-unwanted ratio of the input while the voice talks (what there is to improve). */
function inputSnr(voice, unwanted, frames) {
  let a = 0,
    b = 0;
  for (const f of frames)
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) {
      a += voice[i] ** 2;
      b += unwanted[i] ** 2;
    }
  return 10 * Math.log10(a / Math.max(b, 1e-18));
}

// ------------------------------------------------- what an office is full of ----
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}
const peakScale = (x, peakDb) => {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  const k = Math.pow(10, peakDb / 20) / (p || 1);
  return x.map((v) => v * k);
};

/** A door closing: a low thud (damped body resonances) and a short bang, ~250 ms. */
function doors(n, perSecond, peakDb, seed = 11) {
  const r = rng(seed);
  const x = new Float32Array(n);
  const count = Math.floor((n / FS) * perSecond);
  for (let k = 0; k < count; k++) {
    const at = Math.floor(((r() + 1) / 2) * (n - FS));
    const len = Math.floor(0.4 * FS);
    const f = [65 + 20 * r(), 110 + 30 * r(), 190 + 40 * r(), 310 + 60 * r()];
    const tau = [0.09, 0.07, 0.045, 0.03];
    const w = [1, 0.8, 0.5, 0.3];
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / FS;
      let v = 0;
      for (let j = 0; j < 4; j++)
        v += w[j] * Math.sin(2 * Math.PI * f[j] * t) * Math.exp(-t / tau[j]);
      lp += (r() - lp) * 0.3;
      v += 1.2 * lp * Math.exp(-t / 0.012);
      x[at + i] += v;
    }
  }
  return peakScale(x, peakDb);
}

/** Clapping: sharp broadband claps, with a short room tail, single or as applause. */
function claps(n, perSecond, peakDb, seed = 13) {
  const r = rng(seed);
  const x = new Float32Array(n);
  const count = Math.floor((n / FS) * perSecond);
  for (let k = 0; k < count; k++) {
    const at = Math.floor(((r() + 1) / 2) * (n - FS));
    const len = Math.floor(0.25 * FS);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / FS;
      lp += (r() - lp) * 0.7;
      x[at + i] += lp * (Math.exp(-t / 0.006) + 0.12 * Math.exp(-t / 0.07));
    }
  }
  return peakScale(x, peakDb);
}

/** Typing on a keyboard: bursts of 6 to 9 keys a second, each a click, a thock and a release. */
function typing(n, peakDb, seed = 17) {
  const r = rng(seed);
  const x = new Float32Array(n);
  let t = 0.3;
  while (t * FS < n - FS / 2) {
    const burst = 8 + Math.floor(((r() + 1) / 2) * 20);
    for (let k = 0; k < burst && t * FS < n - FS / 2; k++) {
      const key = (amp, down) => {
        const at = Math.floor(t * FS) + (down ? 0 : Math.floor(0.07 * FS));
        const len = Math.floor(0.045 * FS);
        const f = 180 + 160 * r();
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const s = i / FS;
          lp += (r() - lp) * 0.6;
          x[at + i] +=
            amp *
            (1.0 * lp * Math.exp(-s / 0.002) +
              (down ? 0.8 : 0.3) * Math.sin(2 * Math.PI * f * s) * Math.exp(-s / 0.012));
        }
      };
      const amp = 0.5 + 0.5 * ((r() + 1) / 2);
      key(amp, true);
      key(amp * 0.4, false);
      t += 0.1 + 0.08 * ((r() + 1) / 2);
    }
    t += 1.2 + 2.5 * ((r() + 1) / 2);
  }
  return peakScale(x, peakDb);
}

/** Music from a phone's speaker: a tune in the voice's range, with harmonics, a bass and hi-hats. */
function music(n, dbfs, bpm = 100, seed = 19) {
  const r = rng(seed);
  const x = new Float32Array(n);
  const scale = [196, 220, 261.6, 293.7, 329.6, 392, 440, 523.3, 587.3];
  const beat = (60 / bpm) * FS;
  let at = 0;
  let idx = 3;
  while (at < n) {
    idx = Math.max(0, Math.min(scale.length - 1, idx + Math.round(r() * 2)));
    const f0 = scale[idx];
    const len = Math.floor(beat * (r() > 0 ? 1 : 0.5));
    for (let i = 0; i < len && at + i < n; i++) {
      const t = i / FS;
      const env = Math.min(1, t / 0.01) * Math.exp(-t / 0.35);
      const f = f0 * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t));
      let v = 0;
      for (let k = 1; k <= 9; k++) v += (1 / k) * Math.sin(2 * Math.PI * f * k * t);
      x[at + i] += 0.5 * env * v;
    }
    // Bass drum on the beat, hi-hat in between.
    for (let i = 0; i < Math.floor(0.15 * FS) && at + i < n; i++) {
      const t = i / FS;
      x[at + i] +=
        0.9 * Math.sin(2 * Math.PI * (55 + 40 * Math.exp(-t / 0.03)) * t) * Math.exp(-t / 0.06);
    }
    const hh = at + Math.floor(beat / 2);
    let lp = 0;
    for (let i = 0; i < Math.floor(0.04 * FS) && hh + i < n; i++) {
      const t = i / FS;
      const w = r();
      lp = w - lp * 0.3;
      x[hh + i] += 0.12 * lp * Math.exp(-t / 0.012);
    }
    at += len;
  }
  return scaleTo(x, dbfs);
}

// ----------------------------------------------------------------- the scenarios ----
const dir = mkdtempSync(join(tmpdir(), 'intercom-noise-'));
let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${name} (${detail})`);
};

try {
  mkdirSync(dir, { recursive: true });
  console.log('Making the test speech with the Windows voices...');
  makeSpeech(dir);
  const user = load(dir, 'user');
  const colleague = load(dir, 'colleague');
  const parts = sentences(user);
  const take = compose(parts, 3.5);
  const keep = silentFrames(take.spans, take.length);
  console.log(
    `${parts.length} sentences, ${((keep.filter(Boolean).length * FRAME) / FS).toFixed(0)} s of silence to judge\n`,
  );
  const fmt = (v) => v.toFixed(1);

  console.log('1. The user alone at different microphone levels: none of the voice may be lost');
  for (const level of [-20, -26, -32, -38, -44, -50]) {
    const v = scaleTo(take.clean, level);
    const s = speechReport(v, throughGate(v));
    // And the voice that goes out is not a quiet one: brought up to about -23 dBFS, or by as much
    // as the leveler may (15 dB at least) when the microphone is far quieter than that.
    const sent = level + s.lossDb;
    check(
      `${level} dBFS`,
      s.lossDb > -1.5 && s.cut10 <= 3 && sent >= Math.min(-24, level + 15),
      `${fmt(s.lossDb)} dB, sent at ${fmt(sent)} dBFS, ${fmt(s.cut10)} % of frames cut by more than 10 dB`,
    );
  }

  console.log('\n2. Typing and mouse clicks while the user is silent (voice at -30 dBFS)');
  for (const [peak, wanted] of [
    [-34, 18],
    [-28, 12],
    [-22, 12],
    [-16, 8],
  ]) {
    const v = scaleTo(take.clean, -30);
    const x = clicks(take.length, 6, peak);
    const r = throughGate(mix(v, x));
    const s = speechReport(v, r);
    const removed = removedDb(x, r, keep, s.lossDb);
    check(
      `clicks peaking at ${peak} dBFS`,
      removed >= wanted && s.cut10 <= 3,
      `${fmt(removed)} dB removed against the voice (at least ${wanted}); voice ${fmt(s.lossDb)} dB, ${fmt(s.cut10)} % cut`,
    );
  }

  console.log('\n3. Steady room noise (voice at -30 dBFS)');
  for (const level of [-56, -48, -42]) {
    const v = scaleTo(take.clean, -30);
    const n = noise(take.length, level, 3);
    const r = throughGate(mix(v, n));
    const s = speechReport(v, r);
    const removed = removedDb(n, r, keep, s.lossDb);
    check(
      `room at ${level} dBFS`,
      removed >= 20 && s.cut10 <= 3.5,
      `${fmt(removed)} dB removed against the voice (at least 20); voice ${fmt(s.lossDb)} dB, ${fmt(s.cut10)} % cut`,
    );
  }

  console.log(
    '\n4. A colleague talking in the silences, far from the microphone (voice at -30 dBFS)',
  );
  for (const rel of [-24, -30]) {
    const v = scaleTo(take.clean, -30);
    const c = scaleTo(colleague, -30 + rel);
    const talk = new Float32Array(take.length);
    for (let k = 0; (0.8 + k * 3.7) * FS < take.length; k++) {
      const start = Math.floor((0.8 + k * 3.7) * FS);
      talk.set(c.subarray(0, Math.min(c.length, take.length - start, 3 * FS)), start);
    }
    const r = throughGate(mix(v, talk));
    const s = speechReport(v, r);
    const removed = removedDb(talk, r, keep, s.lossDb);
    check(
      `colleague ${-rel} dB below the user`,
      removed >= 7 && s.cut10 <= 3,
      `${fmt(removed)} dB removed against the voice (at least 7); voice ${fmt(s.lossDb)} dB, ${fmt(s.cut10)} % cut`,
    );
  }

  console.log(
    '\n5. The user turns away from the microphone: 18 dB quieter from the fifth sentence on',
  );
  {
    const turned = compose(parts, 3.5, (i) => (i < 4 ? -26 : -44));
    const r = throughGate(turned.clean);
    const out = aligned(r, turned.clean.length);
    const kept = turned.spans.map(([a, b]) => {
      let ein = 0,
        eout = 0;
      for (let k = a; k < Math.min(b, turned.clean.length); k++) {
        ein += turned.clean[k] ** 2;
        eout += out[k] ** 2;
      }
      return 10 * Math.log10(eout / ein);
    });
    check(
      'before the turn',
      kept.slice(0, 4).every((k) => k > -1.5),
      kept.slice(0, 4).map(fmt).join(', ') + ' dB',
    );
    check(
      'recovered by the seventh sentence',
      kept.slice(6).every((k) => k > -1.5),
      kept.slice(6).map(fmt).join(', ') + ' dB (sentences 5 and 6 may lose their start)',
    );
  }

  // The three below look at the voice while it talks (against what is in it), not only the pauses.
  const talkIn = (c) => {
    const talk = new Float32Array(take.length);
    for (let k = 0; (0.8 + k * 3.7) * FS < take.length; k++) {
      const start = Math.floor((0.8 + k * 3.7) * FS);
      talk.set(c.subarray(0, Math.min(c.length, take.length - start, 3 * FS)), start);
    }
    return talk;
  };
  const voice30 = scaleTo(take.clean, -30);
  const voiceRef = highpass(voice30);
  const frames = speechFrames(voice30);

  console.log('\n6. A loud room: the voice only 4 to 6 dB above it (voice at -30 dBFS)');
  for (const level of [-36, -34]) {
    const n = noise(take.length, level, 3);
    const r = throughGate(mix(voice30, n));
    const q = voiceQuality(voiceRef, aligned(r, take.length), frames);
    const removed = removedDb(n, r, keep, q.gainDb);
    const before = inputSnr(voice30, n, frames);
    check(
      `room at ${level} dBFS`,
      q.cut <= 4 && q.gainDb >= -3 && q.snr >= before - 0.5 && removed >= 10,
      `voice ${fmt(q.gainDb)} dB, ${fmt(q.cut)} % cut, ${fmt(before)} -> ${fmt(q.snr)} dB against the room; ${fmt(removed)} dB of it removed in the pauses (at least 10)`,
    );
  }

  console.log('\n7. Typing and clicks also while the user talks (voice at -30 dBFS)');
  const settled = settledFrames(frames);
  for (const peak of [-22, -16]) {
    const x = clicks(take.length, 6, peak);
    const r = throughGate(mix(voice30, x));
    const q = voiceQuality(voiceRef, aligned(r, take.length), settled);
    const before = inputSnr(voice30, x, settled);
    check(
      `clicks peaking at ${peak} dBFS`,
      q.cut <= 3 && q.snr >= before - 1,
      `voice ${fmt(q.gainDb)} dB, ${fmt(q.cut)} % cut, ${fmt(before)} -> ${fmt(q.snr)} dB against the clicks (it must not get worse)`,
    );
  }

  console.log(
    '\n8. A colleague close by talks before the user and between sentences, 12 dB below them (voice at -30 dBFS)',
  );
  {
    const talk = talkIn(scaleTo(colleague, -42));
    const r = throughGate(mix(voice30, talk));
    const q = voiceQuality(voiceRef, aligned(r, take.length), frames);
    const sent = -30 + q.gainDb;
    check(
      'the user is not made too loud',
      sent <= -19 && sent >= -26 && q.cut <= 3,
      `sent at ${fmt(sent)} dBFS (between -26 and -19; the colleague gets through, as before), ${fmt(q.cut)} % cut`,
    );
  }

  console.log(
    '\n9. A door, clapping, typing and music from a phone, in the pauses (peak levels against the voice)',
  );
  // [name, signal, the least removed (dB, against the voice) at voice -30 dBFS and at -42 dBFS]
  const office = (voiceDb) => [
    ['door slam, peak 4 dB over', doors(take.length, 0.35, voiceDb), 16, 15],
    ['door slam, peak 10 dB over', doors(take.length, 0.35, voiceDb + 6), 9, 15],
    ['door slam, peak 16 dB over', doors(take.length, 0.35, voiceDb + 12), 8, 8],
    ['clapping, peak 10 dB over', claps(take.length, 0.6, voiceDb + 6), 28, 28],
    ['typing, peak 4 dB over', typing(take.length, voiceDb + 4), 16, 28],
    ['typing, peak 10 dB over', typing(take.length, voiceDb + 10), 12, 12],
    ['music 16 dB below the voice', music(take.length, voiceDb - 16), 5, 15],
    ['music 10 dB below the voice', music(take.length, voiceDb - 10), 2, 6],
  ];
  for (const voiceDb of [-30, -42]) {
    const v = scaleTo(take.clean, voiceDb);
    for (const [name, x, atLoud, atQuiet] of office(voiceDb)) {
      const r = throughGate(mix(v, x));
      const s = speechReport(v, r);
      const removed = removedDb(x, r, keep, s.lossDb);
      const wanted = voiceDb === -30 ? atLoud : atQuiet;
      check(
        `${name} (voice at ${voiceDb} dBFS)`,
        removed >= wanted,
        `${fmt(removed)} dB removed against the voice (at least ${wanted}); voice ${fmt(s.lossDb)} dB`,
      );
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\ncheck-noise: ${failed === 0 ? 'all checks passed' : `${failed} check(s) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);

// Measures the call noise gate (apps/desktop/renderer/src/calls/gate.ts) on real speech.
//
//   node tools/scripts/check-noise.mjs
//
// Needs Windows (its text-to-speech voices make the speech: "David" is the user and "Zira" a
// colleague) and ffmpeg (on the path, or from `winget install Gyan.FFmpeg`). Nothing is recorded
// or stored: the speech is made in a temporary folder and removed. Each scenario prints what the
// gate did, and the script fails if it cost the user their voice or let the unwanted through:
//
//  - the user alone, at microphone levels from -20 to -50 dBFS: nothing of the voice may be lost;
//  - key presses and mouse clicks, steady room noise, and a quiet colleague nearby, in the pauses;
//  - the user turning away from the microphone (18 dB quieter): recovers within a sentence or two.
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

/** How much of `unwanted` was removed in the silent frames. */
function removedDb(unwanted, r, keep) {
  const out = aligned(r, unwanted.length);
  let inE = 0,
    outE = 0;
  keep.forEach((k, f) => {
    if (!k) return;
    inE += rmsOf(unwanted, f) ** 2;
    outE += rmsOf(out, f) ** 2;
  });
  return 10 * Math.log10(inE / Math.max(outE, 1e-18));
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
    check(
      `${level} dBFS`,
      s.lossDb > -1.5 && s.cut10 <= 3,
      `${fmt(s.lossDb)} dB, ${fmt(s.cut10)} % of frames cut by more than 10 dB`,
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
    const removed = removedDb(x, r, keep);
    check(
      `clicks peaking at ${peak} dBFS`,
      removed >= wanted && s.cut10 <= 3,
      `${fmt(removed)} dB removed (at least ${wanted}); voice ${fmt(s.lossDb)} dB, ${fmt(s.cut10)} % cut`,
    );
  }

  console.log('\n3. Steady room noise (voice at -30 dBFS)');
  for (const level of [-56, -48, -42]) {
    const v = scaleTo(take.clean, -30);
    const n = noise(take.length, level, 3);
    const r = throughGate(mix(v, n));
    const s = speechReport(v, r);
    const removed = removedDb(n, r, keep);
    check(
      `room at ${level} dBFS`,
      removed >= 20 && s.cut10 <= 3.5,
      `${fmt(removed)} dB removed (at least 20); voice ${fmt(s.lossDb)} dB, ${fmt(s.cut10)} % cut`,
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
    const removed = removedDb(talk, r, keep);
    check(
      `colleague ${-rel} dB below the user`,
      removed >= 7 && s.cut10 <= 3,
      `${fmt(removed)} dB removed (at least 7); voice ${fmt(s.lossDb)} dB, ${fmt(s.cut10)} % cut`,
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\ncheck-noise: ${failed === 0 ? 'all checks passed' : `${failed} check(s) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);

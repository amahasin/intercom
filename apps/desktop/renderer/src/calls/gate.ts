/**
 * Noise suppression for what this PC sends.
 *
 * The browser's own suppression removes steady noise (fans, hiss) and echo, but not what an open
 * office is full of: keyboards, mouse clicks, other people talking, and sound far from the
 * microphone. "High" adds a gate in front of what is sent. Its first rule is that it must never
 * cost the user their voice, at any microphone level; its second is to let as little else through
 * as that allows:
 *
 *  - What a voice is: sound that is periodic (a voice has a pitch, 80 to 400 Hz; a key press, a
 *    mouse click or a thud on the desk does not) opens the gate after about 30 ms. Sound that is
 *    not periodic (a whisper, "s", "f", "sh") opens it only once it has gone on for about 75 ms,
 *    which a click never does. The audio is delayed by a few blocks (`LOOKAHEAD_BLOCKS`) so the
 *    start of a word is not lost to that decision.
 *  - How loud the user is: learned from the sustained voiced sound the microphone hears (a decaying
 *    histogram of its levels, not from what the gate let through, so a quiet microphone can never
 *    lock the gate shut). Sound much below that level (a colleague across the room, a distant TV)
 *    stays shut out. Until there is a level, anything voiced and clearly above the room opens it.
 *  - The room: the level of the quiet between sounds, which drops at once and rises slowly while
 *    the user is talking, so speech does not raise it, but quickly otherwise, so a new steady noise
 *    (a fan starting) is ignored within seconds instead of holding the gate open.
 *  - After speech it holds for about half a second, so words are not clipped, and it never switches
 *    with a click: the gain is ramped. Closed, it lowers sound by about 34 dB, not to nothing.
 *
 * It also stops the browser's automatic gain control, which raises far-away sound to the level of
 * a voice.
 */

/** The microphone constraints used here (a subset of the DOM's MediaTrackConstraints). */
export interface MicConstraints {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/** What the browser is asked for at the microphone for each level. */
export function micConstraints(level: 'off' | 'standard' | 'high'): MicConstraints {
  return {
    echoCancellation: level !== 'off',
    noiseSuppression: level !== 'off',
    // Automatic gain raises far-away sound to the level of a voice: not with the gate.
    autoGainControl: level === 'standard',
  };
}

/** Gain when the gate is closed (about -34 dB): all but silent, but never a hard cut. */
export const CLOSED_GAIN = 0.02;
export const BLOCK = 512;
/** The sound is delayed by this many blocks (about 64 ms) so the gate can see a word coming. */
export const LOOKAHEAD_BLOCKS = 6;
/** Voiced blocks in a row that open the gate (about 32 ms). */
const VOICED_ATTACK_BLOCKS = 3;
/** Unvoiced blocks in a row that open it (about 53 ms: "s", "f", a whisper; a click is never this long). */
const SUSTAINED_ATTACK_BLOCKS = 5;
/** Blocks in a row, above what keeps it open, that hold it open (about 32 ms: not a click). */
const KEEP_BLOCKS = 3;
/**
 * About 0.65 seconds of voiced sound (a few words: about half of speech is voiced) that is too
 * quiet to open the gate, with no speech at the learned level for 3 seconds: the user has moved
 * away from the microphone (or turned away from it), and that quieter voice is now their voice.
 */
const STARVED_BLOCKS = 60;
const NORMAL_SILENCE_BLOCKS = 280;
/** About 480 ms at 48 kHz. */
const HOLD_BLOCKS = 45;
const MIN_THRESHOLD = 0.002; // about -54 dBFS
/** Against the room's level: how far above it a sound must be to open the gate, and to keep it open. */
const FLOOR_OPEN = 3.5;
const FLOOR_KEEP = 2.5;
/**
 * Against the user's usual voice level (the median of the loudness of what they say): sound must
 * reach 0.3 of it (-10 dB) to open the gate and stay above 0.12 (-18 dB) to hold it open, so a
 * quiet word after a loud one is not lost and a colleague talking quietly farther away is shut out.
 */
const OPEN_RATIO = 0.3;
const KEEP_RATIO = 0.12;
/** The lower bar for sound that is not voiced but goes on (a fricative): a click never does. */
const SUSTAIN_RATIO = 0.12;
/** A single block counts for at most this much more than the level learned so far (a shout, a laugh). */
const OUTLIER = 2;
/**
 * How much of the sound is high-frequency (the size of the sample-to-sample change against the
 * level: about 0.1 to 0.4 for a voice, 0.8 and up for a click or a hiss).
 */
const CLICK_BRIGHTNESS = 0.85;
/** The normalized autocorrelation at the best lag, above which a block counts as having a pitch. */
const PERIODIC = 0.4;
/** Floor adaptation per block: up slowly while the user speaks, faster otherwise. */
const FLOOR_RISE_SLOW = 0.0004;
const FLOOR_RISE_FAST = 0.003;

// ---------------------------------------------------------------------------------------------
// Pitch: is there a voice in this block?
// ---------------------------------------------------------------------------------------------

/** The sound is looked at for a pitch at about 8 kHz. */
const DECIMATE = 6;
/** About 32 ms at 8 kHz. */
const PITCH_WINDOW = 256;
/** 400 Hz down to 80 Hz at 8 kHz. */
const MIN_LAG = 20;
const MAX_LAG = 100;

/**
 * How periodic the last `PITCH_WINDOW` samples of `x` (at about 8 kHz, `PITCH_WINDOW + MAX_LAG`
 * long) are: the best normalized autocorrelation over lags that mean 80 to 400 Hz, from 0 (noise,
 * a click) to 1 (a pure tone). A vowel is 0.6 and up.
 */
export function periodicity(x: Float32Array): number {
  const n = PITCH_WINDOW;
  let mean = 0;
  for (let i = 0; i < n + MAX_LAG; i++) mean += x[i]!;
  mean /= n + MAX_LAG;
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += (x[i]! - mean) ** 2;
  if (e0 < 1e-12) return 0;
  let best = 0;
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
    let cross = 0;
    let e1 = 0;
    for (let i = 0; i < n; i++) {
      const b = x[i + lag]! - mean;
      cross += (x[i]! - mean) * b;
      e1 += b * b;
    }
    if (e1 < 1e-12) continue;
    const r = cross / Math.sqrt(e0 * e1);
    if (r > best) best = r;
  }
  return Math.min(1, best);
}

// ---------------------------------------------------------------------------------------------
// How loud the user is
// ---------------------------------------------------------------------------------------------

/**
 * A decaying histogram (1 dB bins) of how loud sustained voiced sound has been lately. Its middle is
 * the user's usual voice level: the user is the nearest and loudest voice at their own microphone,
 * and the median is not moved by a shout or a laugh. It learns from voiced sound clearly above the
 * room that is loud enough to open the gate, whether the gate let it through or not.
 */
class VoiceLevel {
  private static readonly BINS = 72;
  private readonly bins = new Float64Array(VoiceLevel.BINS);
  private weight = 0;
  private blocks = 0;

  add(rms: number): void {
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    const bin = Math.min(VoiceLevel.BINS - 1, Math.max(0, Math.round(db + VoiceLevel.BINS)));
    this.bins[bin]! += 1;
    this.weight += 1;
    // Half of what was heard is forgotten in about 23 seconds.
    if (++this.blocks % 94 === 0) {
      for (let i = 0; i < VoiceLevel.BINS; i++) this.bins[i]! *= 0.97;
      this.weight *= 0.97;
    }
  }

  /** Forget what was learned and start again from this level (`weight` blocks' worth of it). */
  reseed(rms: number, weight: number): void {
    this.bins.fill(0);
    this.weight = 0;
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    const bin = Math.min(VoiceLevel.BINS - 1, Math.max(0, Math.round(db + VoiceLevel.BINS)));
    this.bins[bin] = weight;
    this.weight = weight;
  }

  /** The level under which `p` of the recent voiced blocks stayed; 0 until enough has been heard. */
  level(p = 0.5): number {
    if (this.weight < 25) return 0;
    let seen = 0;
    for (let i = 0; i < VoiceLevel.BINS; i++) {
      seen += this.bins[i]!;
      if (seen >= this.weight * p) return Math.pow(10, (i - VoiceLevel.BINS) / 20);
    }
    return 0;
  }
}

/** The gate's decision logic, apart from the audio plumbing so it can be tested. */
export class Gate {
  private floor = 0.003;
  private readonly voice = new VoiceLevel();
  private hold = 0;
  private voicedRun = 0;
  private unvoicedRun = 0;
  private keepRun = 0;
  private loudRun = 0;
  private starved = 0;
  private starvedSum = 0;
  private sinceNormal = 0;
  private open = false;
  private gain = CLOSED_GAIN;
  private env = 0;

  /** The user's usual voice level so far, 0 until it is known (for tests and diagnostics). */
  get voiceLevel(): number {
    return this.voice.level();
  }

  /** What the gate is counting (for tests and diagnostics). */
  get diagnostics(): {
    starved: number;
    sinceNormal: number;
    voice: number;
    room: number;
    open: boolean;
  } {
    return {
      starved: Math.round(this.starved),
      sinceNormal: this.sinceNormal,
      voice: this.voice.level(),
      room: this.floor,
      open: this.open,
    };
  }

  /** Whether the gate is open now (for tests and diagnostics). */
  get isOpen(): boolean {
    return this.open;
  }

  /** The room's level (for tests and diagnostics). */
  get roomLevel(): number {
    return this.floor;
  }

  /**
   * The gain for the block that is `LOOKAHEAD_BLOCKS` old, given the newest block's RMS level, its
   * brightness (see `CLICK_BRIGHTNESS`; 0 when not known) and its periodicity (see `periodicity`;
   * leave out when not known: then brightness alone decides what looks like a voice).
   */
  next(rms: number, brightness = 0, periodic?: number): number {
    this.env = Math.max(rms, this.env * 0.9);
    const voiced =
      brightness < CLICK_BRIGHTNESS && (periodic === undefined || periodic >= PERIODIC);

    // The room's level: drops at once, rises slowly while speech is going on (so it does not
    // follow the voice up) and quickly otherwise (so a steady noise that starts is learned).
    const speaking = this.open && voiced;
    this.floor =
      rms < this.floor
        ? rms
        : this.floor + (rms - this.floor) * (speaking ? FLOOR_RISE_SLOW : FLOOR_RISE_FAST);
    this.floor = Math.max(this.floor, 0.0005);

    const voice = this.voice.level();
    // Opening needs more than keeping open does, so the end of a word is not chopped.
    const openAt = Math.max(this.floor * FLOOR_OPEN, voice * OPEN_RATIO, MIN_THRESHOLD);
    const sustainAt = Math.max(this.floor * FLOOR_OPEN, voice * SUSTAIN_RATIO, MIN_THRESHOLD);
    const keepAt = Math.max(this.floor * FLOOR_KEEP, voice * KEEP_RATIO, MIN_THRESHOLD * 0.7);
    this.voicedRun = voiced && rms > openAt ? this.voicedRun + 1 : 0;
    this.unvoicedRun = !voiced && rms > sustainAt ? this.unvoicedRun + 1 : 0;
    this.keepRun = rms > keepAt ? this.keepRun + 1 : 0;

    if (!this.open) {
      if (this.voicedRun >= VOICED_ATTACK_BLOCKS || this.unvoicedRun >= SUSTAINED_ATTACK_BLOCKS) {
        this.open = true;
        this.hold = HOLD_BLOCKS;
      }
    } else if (this.keepRun >= KEEP_BLOCKS) {
      // Only sound that goes on holds it: a click every few hundred milliseconds does not.
      this.hold = HOLD_BLOCKS;
    } else if (--this.hold <= 0) {
      this.open = false;
      this.voicedRun = 0;
      this.unvoicedRun = 0;
    }

    // The voice's usual level: from sustained voiced sound that is loud enough to open the gate (a
    // colleague far away is not counted), whether or not the gate is open for it.
    const clear = rms > Math.max(this.floor * 5, MIN_THRESHOLD * 1.5);
    this.loudRun = voiced && clear && rms > voice * OPEN_RATIO ? this.loudRun + 1 : 0;
    if (this.loudRun >= 4) this.voice.add(voice > 0 ? Math.min(rms, voice * OUTLIER) : rms);

    // A voice that has gone quieter than the learned level for good (the user turned away from the
    // microphone) must not stay locked out: after a while of it, it becomes the learned level.
    this.sinceNormal++;
    if (voiced && rms > voice * OPEN_RATIO) {
      // Voiced sound at the learned level: the user is still there, so start the count over.
      this.sinceNormal = 0;
      this.starved = 0;
      this.starvedSum = 0;
    } else if (voice > 0 && voiced && rms > Math.max(this.floor * FLOOR_OPEN, MIN_THRESHOLD)) {
      this.starved++;
      this.starvedSum += rms;
      if (this.starved >= STARVED_BLOCKS && this.sinceNormal >= NORMAL_SILENCE_BLOCKS) {
        this.voice.reseed(this.starvedSum / this.starved, 30);
        this.starved = 0;
        this.starvedSum = 0;
      }
    } else if (this.starved > 0) {
      // Consonants and pauses do not cancel it: only a very slow fade, and the user's own speech above.
      const before = this.starved;
      this.starved = Math.max(0, this.starved - 0.005);
      if (before > 0) this.starvedSum *= this.starved / before;
    }

    const target = this.open ? 1 : CLOSED_GAIN;
    this.gain += (target - this.gain) * (target > this.gain ? 0.6 : 0.05);
    return this.gain;
  }
}

// ---------------------------------------------------------------------------------------------
// The whole gate, per sample: what runs on the audio thread (see gate.worklet.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Delays what comes in by `LOOKAHEAD_BLOCKS` blocks, looks at each block (level, brightness,
 * pitch) and applies the `Gate`'s decision per sample, quick to open and slow to close, so the
 * sound never steps from one level to another. Kept apart from the audio worklet so the same code
 * is tested.
 */
export class GateProcessorCore {
  private readonly gate = new Gate();
  private readonly delay = LOOKAHEAD_BLOCKS * BLOCK;
  private readonly ring = new Float32Array(this.delay + BLOCK);
  private write = 0;
  private filled = 0;
  private previous = 0;
  private sumSquares = 0;
  private sumChange = 0;
  private target = CLOSED_GAIN;
  private gain = CLOSED_GAIN;
  private readonly attack: number;
  private readonly release: number;
  // The sound at about 8 kHz, for the pitch.
  private readonly pitch = new Float32Array(PITCH_WINDOW + MAX_LAG);
  private pitchSum = 0;
  private pitchCount = 0;
  private readonly scratch = new Float32Array(PITCH_WINDOW + MAX_LAG);

  constructor(sampleRate: number) {
    // Open in about 3 ms, close over about 80 ms.
    this.attack = 1 - Math.exp(-1 / (0.003 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.08 * sampleRate));
  }

  /** The delay this adds, in samples. */
  get latency(): number {
    return this.delay;
  }

  get state(): Gate {
    return this.gate;
  }

  process(input: Float32Array | undefined, output: Float32Array): void {
    const ring = this.ring;
    const size = ring.length;
    for (let i = 0; i < output.length; i++) {
      const x = input?.[i] ?? 0;
      // The newest sample in; the one from `delay` samples ago out.
      ring[this.write] = x;
      const old = ring[(this.write + size - this.delay) % size]!;
      this.write = (this.write + 1) % size;
      const d = x - this.previous;
      this.previous = x;
      this.sumSquares += x * x;
      this.sumChange += d * d;
      this.pitchSum += x;
      if (++this.pitchCount === DECIMATE) {
        // Shift in the average of DECIMATE samples (a crude low-pass and a slower rate).
        this.pitch.copyWithin(0, 1);
        this.pitch[this.pitch.length - 1] = this.pitchSum / DECIMATE;
        this.pitchSum = 0;
        this.pitchCount = 0;
      }
      if (++this.filled === BLOCK) {
        const rms = Math.sqrt(this.sumSquares / BLOCK);
        const brightness = this.sumSquares > 0 ? Math.sqrt(this.sumChange / this.sumSquares) : 0;
        // The pitch is only looked for when the block is loud enough to matter.
        let pitched: number | undefined;
        if (rms > MIN_THRESHOLD * 0.5) {
          this.scratch.set(this.pitch);
          pitched = periodicity(this.scratch);
        } else pitched = 0;
        this.target = this.gate.next(rms, brightness, pitched);
        this.filled = 0;
        this.sumSquares = 0;
        this.sumChange = 0;
      }
      this.gain +=
        (this.target - this.gain) * (this.target > this.gain ? this.attack : this.release);
      output[i] = old * this.gain;
    }
  }
}

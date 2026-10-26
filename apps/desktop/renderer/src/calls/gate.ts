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
 *  - A clear pitch is the strongest evidence there is, and it does not depend on how loud the room
 *    is: steady noise scores under 0.25 on the pitch measure, a vowel 0.6 and up. A block with a
 *    clear pitch (0.5 and up) therefore needs only a small margin over the room to open the gate,
 *    keep it open and teach it the voice level (see `FLOOR_OPEN_STRONG`), so a voice 4 dB above a
 *    loud fan is still heard. Everything else keeps the full margins. A level that does not change
 *    for about 3 seconds is a hum, not speech, and the room's level follows it quickly.
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
 * a voice. That control was also what kept a voice loud: with it off, the browser's suppression
 * takes some of the voice's level off with the noise, and a quiet microphone is quiet to the
 * colleague. So after the gate a leveler brings the user's own voice (the level the gate has
 * learned, never what the gate keeps out) up to a steady level (`MAKEUP_TARGET`), by at most
 * `MAKEUP_MAX`, slowly and only while the gate is open, and a limiter keeps a shout from clipping.
 * A voice that is already loud enough is left as it is: the leveler never lowers anything.
 * It raises only what has shown itself to be speech (see `SPEECH_UP`), so that what gets through the
 * gate that is not the user's voice (a loud key press, a door, music) is not raised with it.
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
/** The usual level of the user's voice that is sent (RMS of voiced sound; about -19 dBFS). */
export const MAKEUP_TARGET = 0.11;
/** The most the voice is raised (about +18 dB): a microphone quieter than that stays quieter. */
export const MAKEUP_MAX = 8;
/**
 * The leveler works from the voice level the gate has learned, and that can be wrong for a while (a
 * colleague close by talked first, so the "voice" it knows is theirs and far too quiet). So it also
 * watches what it would send: the loud voiced parts (the peak of voiced blocks while the gate is
 * open, forgotten with a half-life of about 6 seconds, so it holds across a pause between
 * sentences) must not come out above this level (RMS 0.16, about -16 dBFS: not quite twice the
 * target, where the louder vowels of a voice at the target level are). Whatever it learned, the
 * voice is not made louder than that.
 */
export const MAKEUP_PEAK = 0.16;
/** Per block (about 11 ms) of the decay of that peak: 0.9988 is about 6 seconds to half. */
const PEAK_DECAY = 0.9988;
/**
 * The leveler raises only what has shown itself to be speech, and how sure it is of that (0 to 1)
 * moves per block: up by this much while there is a voiced sound at the user's level that is not
 * rumble (see `LOW_SHARE_LIFT`) and moves the way speech does (see `SPEECH_SPREAD`), down by the
 * amounts below when there is not. Whatever else gets through the gate (a key press, a door, a clap,
 * music) keeps its own level; it was raised by up to 18 dB along with the voice before.
 */
const SPEECH_UP = 0.12;
/** Blocks in a row (about 55 ms: a vowel; a key's thock is shorter) before speech is taken as speech. */
const SPEECH_RUN = 5;
/** Per block within 10 blocks of speech (a consonant, a breath must not cancel it). */
const SPEECH_DOWN_NEAR = 0.002;
/** Per block, further from speech, with the gate open (a key press, a door: it fades at once). */
const SPEECH_DOWN_OPEN = 0.015;
/**
 * Per block, with the gate closed: about 14 seconds to forget it, so the first words after a pause
 * (the user was listening) are raised as the last ones were, and not half a second late.
 */
const SPEECH_DOWN_PAUSE = 0.0008;
/**
 * Raising goes on for this many blocks after speech last went on for a vowel's length (about 350 ms),
 * then is eased out over the next 10: a sound that opens the gate after that, with no speech in it
 * (a door, a clap), is not raised, however sure the leveler was of the voice a moment ago.
 */
const SPEECH_LIVE_BLOCKS = 30;
/** Per block of sound that does not move the way speech does (steady music, a tone). */
const SPEECH_DOWN_STEADY = 0.05;
/**
 * The share of a block's energy below 250 Hz. Speech has 0.2 to 0.6 of it (a deep voice more, up to
 * about 0.8), a door, a thud on the desk or a chair mostly 0.85 and up. Such a block is not counted
 * as voiced (a deep voice still opens the gate, by the sound that goes on, see
 * `SUSTAINED_ATTACK_BLOCKS`), and does not make the leveler sure of speech.
 */
const LOW_SHARE_VOICED = 0.9;
const LOW_SHARE_LIFT = 0.85;
/**
 * Over the last 1.5 seconds (`DYNAMICS_BLOCKS`), the 90th over the 10th percentile of the block
 * levels must be at least this (14 dB): speech has pauses and weak consonants between its words (25 dB
 * and more in a quiet room), music and tones hardly move (under 12 dB). Used only to decide whether to
 * raise the level, never to open or close the gate, so it cannot cost the user their voice. (In a
 * loud room speech does not reach it either: there the voice is not raised, as the noise would be.)
 */
const DYNAMICS_BLOCKS = 128;
const SPEECH_SPREAD = 5;
/** Above this, a sample is eased towards 1 instead of being cut off. */
const LIMIT_KNEE = 0.7;

/** Soft limiter: unchanged below the knee, then bent so that nothing reaches full scale. */
export function limit(x: number): number {
  const a = Math.abs(x);
  if (a <= LIMIT_KNEE) return x;
  const bent = LIMIT_KNEE + (1 - LIMIT_KNEE) * Math.tanh((a - LIMIT_KNEE) / (1 - LIMIT_KNEE));
  return x < 0 ? -bent : bent;
}
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
 * A block that clearly has a pitch (a vowel) is not a fan, a key or a click: steady noise scores
 * under 0.25 on the pitch measure even when it is as loud as the voice, a vowel 0.6 and up. Such a
 * block needs much less above the room to count (a voice 4 dB over a loud room is still a voice),
 * so the margins for it are small. Everything else keeps the full margins above.
 */
const STRONG_PERIODIC = 0.5;
const FLOOR_OPEN_STRONG = 1.6;
const FLOOR_KEEP_STRONG = 1.4;
/**
 * Within this share of its slow average a block's level counts as unchanged, and this many blocks
 * in a row (about 3 seconds) is a steady hum, not speech: the room's level then follows it at the
 * quick rate, so a hum that starts is learned and shut out in seconds, as it was before the small
 * margins above.
 */
const FLAT_TOLERANCE = 0.04;
const FLAT_BLOCKS = 280;
/** The level a pitched block must reach, against the room, to teach the gate the user's voice level. */
const FLOOR_CLEAR = 5;
const FLOOR_CLEAR_STRONG = 2;
/**
 * Against the user's usual voice level (the median of the loudness of what they say): sound must
 * reach 0.3 of it (-10 dB) to open the gate and stay above 0.12 (-18 dB) to hold it open, so a
 * quiet word after a loud one is not lost and a colleague talking quietly farther away is shut out.
 */
const OPEN_RATIO = 0.35;
const KEEP_RATIO = 0.15;
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
  /** A slow average of the block levels, and how many blocks in a row have been level with it. */
  private level = 0;
  private flatRun = 0;
  /** The block levels of the last `DYNAMICS_BLOCKS`, and whether they move like speech does. */
  private readonly recent = new Float32Array(DYNAMICS_BLOCKS);
  private readonly sorted = new Float32Array(DYNAMICS_BLOCKS);
  private recentAt = 0;
  private recentCount = 0;
  private moving = true;

  /** Whether the sound moves the way speech does (see `SPEECH_SPREAD`); true until known. */
  get speechLike(): boolean {
    return this.moving;
  }

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
   * brightness (see `CLICK_BRIGHTNESS`; 0 when not known), its periodicity (see `periodicity`;
   * leave out when not known: then brightness alone decides what looks like a voice) and the share
   * of its energy below 250 Hz (0 when not known).
   */
  next(rms: number, brightness = 0, periodic?: number, lowShare = 0): number {
    this.env = Math.max(rms, this.env * 0.9);
    const voiced =
      brightness < CLICK_BRIGHTNESS &&
      (periodic === undefined || periodic >= PERIODIC) &&
      lowShare <= LOW_SHARE_VOICED;

    this.recent[this.recentAt] = Math.max(rms, 1e-5);
    this.recentAt = (this.recentAt + 1) % DYNAMICS_BLOCKS;
    if (this.recentCount < DYNAMICS_BLOCKS) this.recentCount++;
    if (this.recentAt % 16 === 0 && this.recentCount === DYNAMICS_BLOCKS) {
      // Sorted in a buffer that is kept (nothing is allocated on the audio thread).
      this.sorted.set(this.recent);
      this.sorted.sort();
      const spread =
        this.sorted[Math.floor(DYNAMICS_BLOCKS * 0.9)]! /
        this.sorted[Math.floor(DYNAMICS_BLOCKS * 0.1)]!;
      this.moving = spread >= SPEECH_SPREAD;
    }

    // Speech is never level for long (every syllable is a different loudness); a hum is. A level
    // that stays within a few percent of itself for seconds is not someone talking.
    this.level = this.level === 0 ? rms : this.level + (rms - this.level) * 0.1;
    this.flatRun = Math.abs(rms - this.level) < this.level * FLAT_TOLERANCE ? this.flatRun + 1 : 0;

    // The room's level: drops at once, rises slowly while speech is going on (so it does not
    // follow the voice up) and quickly otherwise (so a steady noise that starts is learned).
    const speaking = this.open && voiced && this.flatRun < FLAT_BLOCKS;
    this.floor =
      rms < this.floor
        ? rms
        : this.floor + (rms - this.floor) * (speaking ? FLOOR_RISE_SLOW : FLOOR_RISE_FAST);
    this.floor = Math.max(this.floor, 0.0005);

    const voice = this.voice.level();
    // A clear pitch is evidence of a voice that does not depend on how loud the room is.
    const strong = voiced && periodic !== undefined && periodic >= STRONG_PERIODIC;
    // Opening needs more than keeping open does, so the end of a word is not chopped.
    const openAt = Math.max(
      this.floor * (strong ? FLOOR_OPEN_STRONG : FLOOR_OPEN),
      voice * OPEN_RATIO,
      MIN_THRESHOLD,
    );
    const sustainAt = Math.max(this.floor * FLOOR_OPEN, voice * SUSTAIN_RATIO, MIN_THRESHOLD);
    const keepAt = Math.max(
      this.floor * (strong ? FLOOR_KEEP_STRONG : FLOOR_KEEP),
      voice * KEEP_RATIO,
      MIN_THRESHOLD * 0.7,
    );
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
    const clear =
      rms > Math.max(this.floor * (strong ? FLOOR_CLEAR_STRONG : FLOOR_CLEAR), MIN_THRESHOLD * 1.5);
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
  private sumLow = 0;
  private low = 0;
  private readonly lowRate: number;
  /** How sure the leveler is that this is speech (0 to 1; see `SPEECH_UP`), and its square. */
  private speech = 0;
  private speechRun = 0;
  private sinceSpeech = 0;
  private ease = 0;
  private target = CLOSED_GAIN;
  private gain = CLOSED_GAIN;
  private readonly attack: number;
  private readonly release: number;
  // The leveler: how much the voice is raised (wanted, and as it is now) and how fast that moves.
  private makeupTarget = 1;
  private makeup = 1;
  /** The loud end of what the voiced, open blocks have been lately (see `MAKEUP_PEAK`). */
  private voicedPeak = 0;
  private readonly makeupUp: number;
  private readonly makeupDown: number;
  // The sound at about 8 kHz, for the pitch.
  private readonly pitch = new Float32Array(PITCH_WINDOW + MAX_LAG);
  private pitchSum = 0;
  private pitchCount = 0;
  private readonly scratch = new Float32Array(PITCH_WINDOW + MAX_LAG);

  constructor(sampleRate: number) {
    // Open in about 3 ms, close over about 80 ms.
    this.attack = 1 - Math.exp(-1 / (0.003 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.08 * sampleRate));
    this.lowRate = 1 - Math.exp((-2 * Math.PI * 250) / sampleRate);
    // Louder over about a second (so breaths and a moment's noise do not pump), softer in 150 ms.
    this.makeupUp = 1 - Math.exp(-1 / (1 * sampleRate));
    this.makeupDown = 1 - Math.exp(-1 / (0.15 * sampleRate));
  }

  /** How much the voice is raised now (1 = not at all), for the tests. */
  get raised(): number {
    return this.makeup;
  }

  /** How much of that is applied now (0 to 1: it is, once the sound has shown itself to be speech). */
  get applied(): number {
    return this.ease;
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
      this.low += (x - this.low) * this.lowRate;
      this.sumLow += this.low * this.low;
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
        const lowShare = this.sumSquares > 0 ? this.sumLow / this.sumSquares : 0;
        this.target = this.gate.next(rms, brightness, pitched, lowShare);
        // Until the gate knows the user's voice there is nothing to level.
        const voice = this.gate.voiceLevel;
        // Whether this block is speech: a pitch, at the user's level, not rumble, not bright.
        const speechBlock =
          this.gate.isOpen &&
          pitched >= PERIODIC &&
          brightness < CLICK_BRIGHTNESS &&
          lowShare <= LOW_SHARE_LIFT &&
          rms > voice * OPEN_RATIO;
        this.speechRun = speechBlock ? this.speechRun + 1 : 0;
        // Speech counts once it has gone on for a vowel's length, not for a thock.
        this.sinceSpeech = this.speechRun >= SPEECH_RUN ? 0 : this.sinceSpeech + 1;
        if (!this.gate.speechLike) this.speech = Math.max(0, this.speech - SPEECH_DOWN_STEADY);
        else if (this.speechRun >= SPEECH_RUN) this.speech = Math.min(1, this.speech + SPEECH_UP);
        else if (!speechBlock) {
          const down =
            this.sinceSpeech <= 10
              ? SPEECH_DOWN_NEAR
              : this.gate.isOpen
                ? SPEECH_DOWN_OPEN
                : SPEECH_DOWN_PAUSE;
          this.speech = Math.max(0, this.speech - down);
        }
        // Nothing below 0.3 (a thock, a thud), all of it from 0.7: eased between.
        const live = Math.min(1, Math.max(0, 1 - (this.sinceSpeech - SPEECH_LIVE_BLOCKS) / 10));
        this.ease = Math.min(1, Math.max(0, (this.speech - 0.25) / 0.3)) * live;
        const wanted = voice > 0 ? Math.min(MAKEUP_MAX, Math.max(1, MAKEUP_TARGET / voice)) : 1;
        // What the voiced, open blocks reach lately, and so how much the leveler may raise them.
        this.voicedPeak *= PEAK_DECAY;
        if (this.gate.isOpen && pitched >= PERIODIC && rms > this.voicedPeak) this.voicedPeak = rms;
        const ceiling = this.voicedPeak > 0 ? MAKEUP_PEAK / this.voicedPeak : MAKEUP_MAX;
        this.makeupTarget = Math.max(1, Math.min(wanted, ceiling));
        this.filled = 0;
        this.sumSquares = 0;
        this.sumChange = 0;
        this.sumLow = 0;
      }
      this.gain +=
        (this.target - this.gain) * (this.target > this.gain ? this.attack : this.release);
      this.makeup +=
        (this.makeupTarget - this.makeup) *
        (this.makeupTarget > this.makeup ? this.makeupUp : this.makeupDown);
      // Raised only while the gate is wide open (how open it is, to the sixth power: a click that
      // half opens it gets next to none of it), so what the gate holds down stays down.
      const opened = Math.min(1, Math.max(0, (this.gain - CLOSED_GAIN) / (1 - CLOSED_GAIN)));
      output[i] = limit(old * this.gain * (1 + (this.makeup - 1) * opened ** 6 * this.ease));
    }
  }
}

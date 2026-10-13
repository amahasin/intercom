/**
 * Noise suppression for what this PC sends.
 *
 * The browser's own suppression removes steady noise (fans, hiss) and echo, but not what an open
 * office is full of: keyboards, mouse clicks, other people talking, and sound far from the
 * microphone. "High" adds a gate that lets through only what is clearly this user's own voice:
 *
 *  - Level: the usual level of the user's voice is tracked, and sound well below it (a colleague
 *    across the room, a distant TV) stays shut out, about 40 dB down.
 *  - Shape: a key press or a mouse click is a short, broadband burst; a voice is a sustained
 *    sound with most of its energy low down. The gate opens only for sound that is both loud
 *    enough and not click-like, for a few blocks in a row. The audio is delayed by a few blocks
 *    (see `LOOKAHEAD_BLOCKS`) so the start of a word is not lost to that decision.
 *  - After speech it holds for a moment, so words are not clipped, and it never switches with a
 *    click: the gain is ramped.
 *
 * It also stops the automatic gain control, which is what raises far-away sound to the level of
 * a voice.
 */

/** The microphone constraints used here (a subset of the DOM's MediaTrackConstraints). */
export interface MicConstraints {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  voiceIsolation?: boolean;
}

/** What the browser is asked for at the microphone for each level. */
export function micConstraints(level: 'off' | 'standard' | 'high'): MicConstraints {
  return {
    echoCancellation: level !== 'off',
    noiseSuppression: level !== 'off',
    // Automatic gain raises far-away sound to the level of a voice: not with the gate.
    autoGainControl: level === 'standard',
    // Where the browser has a voice-isolation mode, ask for it (ignored where it has not).
    ...(level === 'high' && { voiceIsolation: true }),
  };
}

/** Gain when the gate is closed (about -40 dB): all but silent. */
export const CLOSED_GAIN = 0.01;
export const BLOCK = 512;
/** The sound is delayed by this many blocks (about 43 ms) so the gate can see a word coming. */
export const LOOKAHEAD_BLOCKS = 4;
/** Blocks in a row that must look like a voice before the gate opens (about 32 ms). */
const ATTACK_BLOCKS = 3;
const HOLD_BLOCKS = 32; // about 340 ms at 48 kHz
const MIN_THRESHOLD = 0.004; // about -48 dBFS
/**
 * Against the user's usual voice level: sound must reach half of it (-6 dB) to open the gate and
 * stay above about a third (-9 dB) to hold it open, so a colleague talking after the user does not
 * keep it open.
 */
const OPEN_RATIO = 0.5;
const KEEP_RATIO = 0.35;
/**
 * How much of the sound is high-frequency (the size of the sample-to-sample change against the
 * level: about 0.1 to 0.4 for a voice, 0.8 and up for a click or a hiss).
 */
const CLICK_BRIGHTNESS = 0.85;

/** The gate's decision logic, apart from the audio plumbing so it can be tested. */
export class Gate {
  private floor = 0.01;
  private voice = 0.04;
  private hold = 0;
  private run = 0;
  private open = false;
  private gain = CLOSED_GAIN;
  private env = 0;

  /**
   * The gain for the block that is `LOOKAHEAD_BLOCKS` old, given the newest block's RMS level and
   * its brightness (see `CLICK_BRIGHTNESS`; 0 when not known).
   */
  next(rms: number, brightness = 0): number {
    this.env = Math.max(rms, this.env * 0.9);
    // The room's level: drops at once, rises slowly (so speech does not raise it).
    this.floor = rms < this.floor ? rms : this.floor + (rms - this.floor) * 0.0004;
    this.floor = Math.max(this.floor, 0.0005);
    // Opening needs more than keeping open does, so the end of a word is not chopped.
    const openAt = Math.max(this.floor * 4, this.voice * OPEN_RATIO, MIN_THRESHOLD);
    const keepAt = Math.max(this.floor * 3, this.voice * KEEP_RATIO, MIN_THRESHOLD * 0.75);
    const voiced = brightness < CLICK_BRIGHTNESS;
    if (!this.open) {
      this.run = rms > openAt && voiced ? this.run + 1 : 0;
      if (this.run >= ATTACK_BLOCKS) {
        this.open = true;
        this.hold = HOLD_BLOCKS;
      }
    } else if (this.env > keepAt) {
      this.hold = HOLD_BLOCKS;
    } else if (--this.hold <= 0) {
      this.open = false;
      this.run = 0;
    }
    // The voice's usual level, from loud voiced blocks only; one shout cannot raise it by much.
    if (this.open && voiced && rms > openAt) {
      const target = Math.min(rms, this.voice * 1.25, 0.5);
      this.voice += (target - this.voice) * (target > this.voice ? 0.015 : 0.01);
      this.voice = Math.max(this.voice, 0.01);
    }
    const target = this.open ? 1 : CLOSED_GAIN;
    this.gain += (target - this.gain) * (target > this.gain ? 0.6 : 0.05);
    return this.gain;
  }
}

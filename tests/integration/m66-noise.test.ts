import { describe, expect, it } from 'vitest';
import { Gate, micConstraints } from '../../apps/desktop/renderer/src/calls/gate.ts';

/** Feed blocks of a given level to the gate; returns the gain it ends on. */
function feed(gate: Gate, level: number, blocks: number): number {
  let gain = 0;
  for (let i = 0; i < blocks; i++) gain = gate.next(level * (1 + 0.1 * Math.sin(i)));
  return gain;
}

describe('M6.6 noise suppression gate', () => {
  it('lets a near voice through and lowers the room, a far voice and keyboard taps', () => {
    const gate = new Gate();
    // The room alone (fan, hum): about -46 dBFS. The gate stays low.
    expect(feed(gate, 0.005, 300)).toBeLessThan(0.1);
    // The user speaks, level about -22 dBFS: open at once.
    expect(feed(gate, 0.08, 40)).toBeGreaterThan(0.95);
    // Keep talking, and a colleague across the room (about -38 dBFS) is far below the voice.
    feed(gate, 0.08, 200);
    // The voice stops; after the hold the gate closes and a far voice stays down.
    feed(gate, 0.005, 60);
    expect(feed(gate, 0.012, 100)).toBeLessThan(0.15);
    // The user speaks again after the pause: the gate reopens.
    expect(feed(gate, 0.08, 30)).toBeGreaterThan(0.9);
  });

  it('does not clip the end of a word (it holds for a moment)', () => {
    const gate = new Gate();
    feed(gate, 0.005, 200);
    feed(gate, 0.08, 100);
    // 150 ms of quiet after speech (about 14 blocks): still open.
    expect(feed(gate, 0.004, 12)).toBeGreaterThan(0.9);
  });

  it('keeps keyboard and mouse clicks out when nobody is talking', () => {
    const gate = new Gate();
    // Settle on a quiet room, and on the user's voice once.
    feed(gate, 0.005, 300);
    feed(gate, 0.08, 60);
    feed(gate, 0.005, 120);
    // A key press: a burst of one to three blocks, well above the room, broadband (bright).
    let loudest = 0;
    for (let tap = 0; tap < 20; tap++) {
      for (let i = 0; i < 3; i++) loudest = Math.max(loudest, gate.next(0.06, 1.2));
      for (let i = 0; i < 20; i++) gate.next(0.005, 0.3);
    }
    // Louder than the voice's own threshold, but never let through.
    expect(loudest).toBeLessThan(0.1);
    // A click that is short but not bright (a thud on the desk) is too short to open it.
    let thud = 0;
    for (let tap = 0; tap < 20; tap++) {
      for (let i = 0; i < 2; i++) thud = Math.max(thud, gate.next(0.06, 0.3));
      for (let i = 0; i < 20; i++) gate.next(0.005, 0.3);
    }
    expect(thud).toBeLessThan(0.1);
    // Speech (sustained, not bright) opens it.
    let gain = 0;
    for (let i = 0; i < 12; i++) gain = gate.next(0.08, 0.25);
    expect(gain).toBeGreaterThan(0.9);
  });

  it('keeps a colleague who talks nearby out, but not the user', () => {
    const gate = new Gate();
    feed(gate, 0.005, 300);
    // The user talks for a while: the gate learns how loud the user is.
    for (let i = 0; i < 300; i++) gate.next(0.1 * (1 + 0.2 * Math.sin(i / 3)), 0.25);
    feed(gate, 0.005, 60);
    // A colleague at a third of the loudness, speech-like (not bright): stays shut out.
    let gain = 0;
    for (let i = 0; i < 400; i++) gain = gate.next(0.03 * (1 + 0.3 * Math.sin(i / 4)), 0.25);
    expect(gain).toBeLessThan(0.05);
    // The user speaks again: through.
    for (let i = 0; i < 20; i++) gain = gate.next(0.1, 0.25);
    expect(gain).toBeGreaterThan(0.9);
  });

  it('does not lock the user out after one shout', () => {
    const gate = new Gate();
    feed(gate, 0.005, 300);
    for (let i = 0; i < 60; i++) gate.next(0.06, 0.25);
    // A shout, then back to a normal voice a little quieter than before.
    for (let i = 0; i < 30; i++) gate.next(0.5, 0.25);
    feed(gate, 0.005, 80);
    let gain = 0;
    for (let i = 0; i < 40; i++) gain = gate.next(0.05, 0.25);
    expect(gain).toBeGreaterThan(0.9);
  });

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
  });
});

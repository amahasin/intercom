import { describe, expect, it } from 'vitest';
import { Meter } from '../src/files/transfer.ts';

describe('Meter (transfer speed)', () => {
  it('says nothing until there is enough to measure', () => {
    const m = new Meter();
    expect(m.rate(0)).toBeUndefined();
    m.add(0, 1_000_000);
    expect(m.rate(100)).toBeUndefined();
    m.add(100, 1_000_000);
    // Under 400 ms of data is too little to quote a speed.
    expect(m.rate(100)).toBeUndefined();
  });

  it('averages bytes a second over the recent window', () => {
    const m = new Meter();
    m.add(0, 1_000_000);
    m.add(500, 1_000_000);
    m.add(1_000, 1_000_000);
    // The first sample only marks the start: 2 MB over 1 s.
    expect(m.rate(1_000)).toBe(2_000_000);
  });

  it('forgets old samples, so the speed follows the transfer', () => {
    const m = new Meter();
    for (let t = 0; t <= 4_000; t += 500) m.add(t, 1_000_000); // 2 MB/s
    for (let t = 4_500; t <= 12_000; t += 500) m.add(t, 100_000); // 0.2 MB/s
    expect(m.rate(12_000)!).toBeLessThan(250_000);
    expect(m.rate(12_000)!).toBeGreaterThan(150_000);
  });

  it('reads 0 when a transfer has gone quiet', () => {
    const m = new Meter();
    m.add(0, 1_000_000);
    m.add(1_000, 1_000_000);
    expect(m.rate(1_000)).toBeGreaterThan(0);
    expect(m.rate(4_000)).toBe(0);
  });
});

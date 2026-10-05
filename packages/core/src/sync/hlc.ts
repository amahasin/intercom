import type { Hlc } from '@officemesh/protocol';
import type { Clock } from '../interfaces.ts';

/** A remote clock may pull ours forward by at most this much (protects against skewed peers). */
export const MAX_HLC_DRIFT_MS = 60_000;

export function compareHlc(a: Hlc, b: Hlc): number {
  return a.t - b.t || a.c - b.c;
}

/**
 * Hybrid logical clock (wall milliseconds + counter). Timestamps it issues always
 * increase, and never fall behind any timestamp it has observed, so display order
 * respects causality even when PC clocks differ slightly.
 */
export class HybridClock {
  private last: Hlc = { t: 0, c: 0 };
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  now(): Hlc {
    const wall = this.clock.now();
    this.last = wall > this.last.t ? { t: wall, c: 0 } : { t: this.last.t, c: this.last.c + 1 };
    return { ...this.last };
  }

  /** Merge a timestamp seen on a received event. */
  observe(remote: Hlc): void {
    const wall = this.clock.now();
    const r = remote.t > wall + MAX_HLC_DRIFT_MS ? { t: wall + MAX_HLC_DRIFT_MS, c: 0 } : remote;
    const t = Math.max(wall, this.last.t, r.t);
    let c = 0;
    if (t === this.last.t && t === r.t) c = Math.max(this.last.c, r.c) + 1;
    else if (t === this.last.t) c = this.last.c + 1;
    else if (t === r.t) c = r.c + 1;
    this.last = { t, c };
  }
}

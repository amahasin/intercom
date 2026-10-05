/**
 * Test doubles for the core's injectable interfaces. Never used by the shipped app.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, KeyProtector, TimerHandle } from '../interfaces.ts';

export { LoopbackDiscoveryHub } from '../discovery/loopback.ts';

/**
 * Stores the key unsealed. Lets the core run as a bare Node process (tests, sim) where
 * Electron safeStorage does not exist. The app refuses to load a key sealed this way.
 */
export class InsecureTestKeyProtector implements KeyProtector {
  readonly scheme = 'insecure-test' as const;
  async protect(plain: Uint8Array): Promise<Uint8Array> {
    return Uint8Array.from(plain);
  }
  async unprotect(sealed: Uint8Array): Promise<Uint8Array> {
    return Uint8Array.from(sealed);
  }
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
  every?: number;
}

/** Deterministic clock: time moves only when `advance` is called. */
export class FakeClock implements Clock {
  private t: number;
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(start = Date.UTC(2026, 9, 5, 9, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms, Math.max(1, ms));
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  /** Move time forward, firing due timers in time order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: FakeTimer | undefined;
      for (const timer of this.timers.values()) {
        if (
          timer.at <= target &&
          (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))
        ) {
          next = timer;
        }
      }
      if (!next) break;
      this.t = next.at;
      if (next.every !== undefined) next.at += next.every;
      else this.timers.delete(next.id);
      next.fn();
    }
    this.t = target;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  private add(fn: () => void, ms: number, every?: number): TimerHandle {
    const id = this.nextId++;
    const timer: FakeTimer = { id, at: this.t + Math.max(0, ms), fn };
    if (every !== undefined) timer.every = every;
    this.timers.set(id, timer);
    return id as unknown as TimerHandle;
  }
}

/** A fresh temporary directory and a disposer that removes it. */
export function makeTempDir(prefix = 'officemesh-'): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true, maxRetries: 5 }) };
}

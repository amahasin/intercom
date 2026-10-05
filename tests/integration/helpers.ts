import type { Core } from '@officemesh/core';
import type { FakeClock } from '@officemesh/core/testing';
import type { PersonView } from '@officemesh/protocol/ipc';

/** Let pending I/O callbacks (setImmediate deliveries) run. */
export async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** Advance a fake clock in small steps, letting async work run between them. */
export async function run(clock: FakeClock, ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    clock.advance(step);
    await settle();
  }
}

/**
 * Advance until `cond` holds; resolves with the simulated milliseconds it took.
 * Throws after `maxMs` so a regression fails with a clear message.
 */
export async function until(
  clock: FakeClock,
  cond: () => boolean,
  maxMs: number,
  step = 100,
): Promise<number> {
  await settle();
  for (let elapsed = 0; elapsed <= maxMs; elapsed += step) {
    if (cond()) return elapsed;
    clock.advance(step);
    await settle();
  }
  throw new Error(`condition not met within ${maxMs} ms of simulated time`);
}

export function person(core: Core, userId: string): PersonView | undefined {
  return core.people().find((p) => p.userId === userId);
}

/** True when every core sees every other one online and with its name. */
export function allKnowEachOther(cores: Core[]): boolean {
  return cores.every((a) =>
    cores.every(
      (b) =>
        a === b ||
        (person(a, b.userId)?.online === true && person(a, b.userId)?.displayName !== undefined),
    ),
  );
}

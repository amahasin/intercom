import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { allKnowEachOther, run, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function pair() {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count: 2, clock });
  sims.push(sim);
  const [a, b] = sim.peers.map((p) => p.core) as [Core, Core];
  await until(clock, () => allKnowEachOther([a, b]), 20_000);
  return { clock, a, b };
}

const personOf = (viewer: Core, userId: string) =>
  viewer.people().find((p) => p.userId === userId)!;

describe('M6.22 a page that follows the colleague', () => {
  it("opening a colleague's page connects to them again if the link is gone, so what they report is current", async () => {
    const { clock, a, b } = await pair();
    const links = a.network!.links;
    expect(links.isReady(b.userId)).toBe(true);
    links.disconnect(b.userId, 'test');
    await run(clock, 500);
    expect(links.isReady(b.userId)).toBe(false);
    a.refreshPerson(b.userId);
    await until(clock, () => links.isReady(b.userId), 10_000);
    expect(personOf(a, b.userId).appVersion).toBeTruthy();
    expect(personOf(a, b.userId).machine).toBeDefined();
    // With the link up, asking again does nothing; and someone nobody knows is not dialled.
    a.refreshPerson(b.userId);
    a.refreshPerson('a'.repeat(32));
  });

  it('a repeat of the same facts only freshens "Reported ... ago"', async () => {
    const { clock, a, b } = await pair();
    a.refreshPerson(b.userId);
    await until(clock, () => personOf(a, b.userId).infoAt !== undefined, 10_000);
    const first = personOf(a, b.userId).infoAt!;
    await run(clock, 120_000);
    // They say it again (a refreshed hello): the time moves on, nothing else changes.
    const changes: number[] = [];
    a.onEvent((n, p) => {
      if (n === 'people.changed')
        for (const v of (p as { people: Array<{ userId: string; infoAt?: number }> }).people)
          if (v.userId === b.userId && v.infoAt !== undefined) changes.push(v.infoAt);
    });
    (
      a.network!.directory as unknown as {
        setInfo(userId: string, app: string, machine: unknown): void;
      }
    ).setInfo(b.userId, personOf(a, b.userId).appVersion!, personOf(a, b.userId).machine);
    await run(clock, 500);
    expect(personOf(a, b.userId).infoAt!).toBeGreaterThan(first);
    expect(changes.length).toBeGreaterThan(0);
  });
});

describe('M6.22 last seen for someone who is away', () => {
  it('says since when: their own word for it, from the beacon', async () => {
    const { clock, a, b } = await pair();
    await run(clock, 10 * 60_000);
    expect(personOf(a, b.userId).presence).toBe('available');
    const before = clock.now();
    // Their PC has been idle for five minutes: Away, and they were last there five minutes ago.
    b.setSystemState({ idle: true });
    await until(clock, () => personOf(a, b.userId).presence === 'away', 15_000);
    const since = personOf(a, b.userId).presenceSince!;
    expect(since).toBeLessThanOrEqual(clock.now());
    expect(before - since).toBeGreaterThan(4 * 60_000);
    expect(before - since).toBeLessThan(6 * 60_000);

    // Time passes: it is still since then, not since the last beacon.
    await run(clock, 20 * 60_000);
    expect(personOf(a, b.userId).presenceSince).toBe(since);

    // Back at the PC: Available, and no "since" is shown for it any more.
    b.setSystemState({ idle: false });
    await until(clock, () => personOf(a, b.userId).presence === 'available', 15_000);
    expect(personOf(a, b.userId).presenceSince).toBeGreaterThan(since);
  });

  it('is gone when they are offline (their last seen takes over)', async () => {
    const { clock, a, b } = await pair();
    b.setSystemState({ idle: true });
    await until(clock, () => personOf(a, b.userId).presence === 'away', 15_000);
    await b.close();
    await until(clock, () => !personOf(a, b.userId).online, 60_000);
    expect(personOf(a, b.userId).presenceSince).toBeUndefined();
  });
});

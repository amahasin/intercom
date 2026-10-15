import { hostname } from 'node:os';
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
  const [a, b] = [0, 1].map((i) => sim.peers[i]!.core) as [Core, Core];
  await until(clock, () => allKnowEachOther([a, b]), 20_000);
  return { clock, a, b };
}

const personOf = (viewer: Core, userId: string) =>
  viewer.people().find((p) => p.userId === userId)!;

describe("M6.19 a colleague's page", () => {
  it("a colleague's version and PC arrive in the handshake and are kept", async () => {
    const { clock, a, b } = await pair();
    // The link comes up when they first talk; give it a moment.
    a.openDirect(b.userId);
    await until(clock, () => personOf(a, b.userId).machine !== undefined, 10_000);
    const seenByA = personOf(a, b.userId);
    expect(seenByA.appVersion).toBeTruthy();
    expect(seenByA.infoAt).toBeGreaterThan(0);
    // Both "PCs" are this one: the facts are this machine's.
    expect(seenByA.machine).toMatchObject({ host: hostname().slice(0, 64) });
    expect(seenByA.machine!.os).toMatch(/\w/);
    expect(seenByA.machine!.arch).toMatch(/\w/);
    expect(seenByA.machine!.memoryMb).toBeGreaterThan(0);
    expect(seenByA.machine!.cores).toBeGreaterThan(0);
    // It is stored, so it is still there for a colleague who is offline.
    const stored = a.store.db
      .prepare('SELECT info_json AS json FROM peers WHERE user_id = ?')
      .get(b.userId) as { json: string };
    expect(JSON.parse(stored.json)).toMatchObject({ app: seenByA.appVersion });
  });

  it('the summary of what two colleagues did together: chat, calls, groups', async () => {
    const { clock, a, b } = await pair();
    // Nothing yet.
    expect(a.personActivity(b.userId)).toMatchObject({
      messages: 0,
      files: 0,
      calls: 0,
      missedCalls: 0,
      talkMs: 0,
      recent: [],
      groups: [],
    });
    const convId = a.openDirect(b.userId).convId;
    await run(clock, 500);
    a.sendMessage(convId, 'morning');
    await run(clock, 200);
    b.sendMessage(convId, 'hello back');
    await run(clock, 200);
    a.sendMessage(convId, 'can you review page 3?');
    await run(clock, 1_000);
    const group = a.createGroup([b.userId], 'Design crit').convId;
    await run(clock, 2_000);

    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const activity = me.personActivity(other.userId);
      expect(activity.convId).toBe(convId);
      expect(activity.messages).toBe(3);
      expect(activity.files).toBe(0);
      expect(activity.firstContactAt).toBeGreaterThan(0);
      // Newest first; each says who sent it.
      expect(activity.recent.map((r) => r.text)).toEqual([
        'can you review page 3?',
        'hello back',
        'morning',
      ]);
      expect(activity.recent[0]!.mine).toBe(me === a);
      expect(activity.groups).toEqual([{ convId: group, title: 'Design crit' }]);
    }
  });

  it('a colleague nobody knows has no page', async () => {
    const { a } = await pair();
    expect(() => a.personActivity('a'.repeat(32))).toThrow(/unknown/);
  });
});

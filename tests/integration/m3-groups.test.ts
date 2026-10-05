import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { allKnowEachOther, run, settle, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function lan(count: number) {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count, clock });
  sims.push(sim);
  const core = (i: number) => sim.peers[i]!.core;
  await until(clock, () => allKnowEachOther(sim.peers.filter(Boolean).map((p) => p.core)), 20_000);
  return { clock, sim, core };
}

/** Message ids and texts in display order: what "identical message order" means. */
const order = (c: Core, convId: string) =>
  c.listMessages(convId, 500).map((m) => `${m.id} ${m.deleted ? '' : m.text}`);

const hasConv = (c: Core, convId: string) =>
  c.conversationList().some((v) => v.convId === convId && v.active);

describe('M3 group chats', () => {
  it('five peers posting concurrently converge to identical message order', async () => {
    const { clock, core } = await lan(5);
    const cores = [0, 1, 2, 3, 4].map(core);
    const group = cores[0]!.createGroup(
      cores.slice(1).map((c) => c.userId),
      'Ops',
    );
    await until(clock, () => cores.every((c) => hasConv(c, group.convId)), 10_000);
    for (const c of cores)
      expect(c.conversationList().find((v) => v.convId === group.convId)?.title).toBe('Ops');

    // Everyone posts at once, several rounds, without waiting for delivery in between.
    for (let round = 0; round < 6; round++) {
      for (const [i, c] of cores.entries()) c.sendMessage(group.convId, `r${round} from ${i}`);
    }
    await until(
      clock,
      () => cores.every((c) => c.listMessages(group.convId, 500).length === 30),
      20_000,
    );
    const first = order(cores[0]!, group.convId);
    for (const c of cores) expect(order(c, group.convId)).toEqual(first);
  });

  it('any member can add and remove; the renamed title and members agree everywhere', async () => {
    const { clock, core } = await lan(4);
    const [a, b, c, d] = [0, 1, 2, 3].map(core) as [Core, Core, Core, Core];
    const g = a.createGroup([b.userId]).convId;
    await until(clock, () => hasConv(b, g), 5_000);
    b.addMembers(g, [c.userId, d.userId]);
    await until(clock, () => hasConv(c, g) && hasConv(d, g), 5_000);
    c.renameConversation(g, 'Lunch crew');
    a.removeMember(g, d.userId);
    await run(clock, 2_000);
    const view = (x: Core) => x.conversationList().find((v) => v.convId === g)!;
    for (const x of [a, b, c]) {
      expect(view(x).title).toBe('Lunch crew');
      expect(view(x).memberCount).toBe(3);
      expect(view(x).active).toBe(true);
    }
    expect(view(d).active).toBe(false);
    expect(() => d.sendMessage(g, 'can I still post?')).toThrow(/no longer a member/);
  });
});

describe('M3 sync', () => {
  it('a member offline during 500 posts gets all of them from one other member, with the authors offline', async () => {
    const { clock, sim, core } = await lan(4);
    const [a, b, relay] = [0, 1, 2].map(core) as [Core, Core, Core];
    const late = core(3);
    const lateId = late.userId;
    const g = a.createGroup([b.userId, relay.userId, lateId]).convId;
    await until(clock, () => [b, relay, late].every((x) => hasConv(x, g)), 5_000);

    await sim.stopPeer(3);
    for (let i = 0; i < 250; i++) {
      a.sendMessage(g, `a${i}`);
      b.sendMessage(g, `b${i}`);
      if (i % 25 === 0) await settle();
    }
    await until(clock, () => relay.listMessages(g, 500).length === 500, 30_000);

    // The authors leave; only the relay is around when the late member returns.
    await sim.stopPeer(0);
    await sim.stopPeer(1);
    const back = (await sim.startPeer(3)).core;
    await until(clock, () => back.listMessages(g, 500).length === 500, 60_000);
    expect(order(back, g)).toEqual(order(relay, g));
  });

  it('a removed member receives nothing posted after removal', async () => {
    const { clock, core } = await lan(3);
    const [a, b, gone] = [0, 1, 2].map(core) as [Core, Core, Core];
    const g = a.createGroup([b.userId, gone.userId]).convId;
    await until(clock, () => hasConv(gone, g), 5_000);
    a.sendMessage(g, 'before removal');
    await until(clock, () => gone.listMessages(g).length === 1, 5_000);
    b.removeMember(g, gone.userId);
    await run(clock, 1_000);
    a.sendMessage(g, 'after removal');
    b.sendMessage(g, 'also after');
    await run(clock, 5_000);
    expect(a.listMessages(g).length).toBe(3);
    expect(gone.listMessages(g).map((m) => m.text)).toEqual(['before removal']);
    // Nothing secret reached the removed PC's log either.
    const stored = gone.store.db
      .prepare(`SELECT count(*) AS n FROM events WHERE conv_id = ? AND type = 'msg.post'`)
      .get(g) as { n: number };
    expect(stored.n).toBe(1);
  });

  it('rebuild reproduces the messages table byte for byte', async () => {
    const { clock, core } = await lan(3);
    const [a, b, c] = [0, 1, 2].map(core) as [Core, Core, Core];
    const g = a.createGroup([b.userId, c.userId]).convId;
    await until(clock, () => hasConv(c, g), 5_000);
    const m1 = a.sendMessage(g, 'hello group');
    b.sendMessage(g, 'hi');
    const poll = c.createPoll(g, { question: 'Pizza or sushi?', options: ['Pizza', 'Sushi'] });
    await run(clock, 1_000);
    a.vote(g, poll, [0]);
    b.vote(g, poll, [1]);
    b.vote(g, poll, [0]);
    b.react(g, m1, '👍', true);
    await run(clock, 1_000);
    c.closePoll(g, poll);
    await run(clock, 1_000);
    expect(() => a.vote(g, poll, [1])).toThrow(/closed/);
    a.removeMember(g, b.userId);
    await run(clock, 2_000);
    for (const x of [a, b, c]) {
      const before = x.messages.dump();
      x.rebuild();
      expect(x.messages.dump()).toBe(before);
    }
    const view = a.listMessages(g).find((m) => m.kindDetail === 'poll')!;
    expect(view.poll).toMatchObject({ closed: true, voters: 2 });
    expect(view.poll!.options.map((o) => o.votes)).toEqual([2, 0]);
  });
});

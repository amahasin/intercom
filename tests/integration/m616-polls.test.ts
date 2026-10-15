import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { allKnowEachOther, run, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function office() {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count: 3, clock });
  sims.push(sim);
  const [a, b, c] = [0, 1, 2].map((i) => sim.peers[i]!.core) as [Core, Core, Core];
  await until(clock, () => allKnowEachOther([a, b, c]), 20_000);
  const g = a.createGroup([b.userId, c.userId]).convId;
  const has = (x: Core) => x.conversationList().some((v) => v.convId === g && v.active);
  await until(clock, () => has(b) && has(c), 10_000);
  return { clock, a, b, c, g };
}

const pollOf = (x: Core, g: string) =>
  x.listMessages(g).find((m) => m.kindDetail === 'poll')!.poll!;

describe('M6.16 polls', () => {
  it('closes by itself at its deadline: later votes do not count, the author sends the close', async () => {
    const { clock, a, b, c, g } = await office();
    const ref = a.createPoll(g, {
      question: 'Lunch?',
      options: ['Pizza', 'Sushi'],
      closesAt: clock.now() + 5 * 60_000,
    });
    await run(clock, 1_000);
    b.vote(g, ref, [1]);
    await run(clock, 1_000);
    for (const x of [a, b, c]) {
      expect(pollOf(x, g)).toMatchObject({ closed: false, voters: 1 });
      expect(pollOf(x, g).closesAt).toBe(ref.at + 5 * 60_000);
    }
    await run(clock, 5 * 60_000);
    // Too late: the poll is closed everywhere, and refuses the vote.
    expect(() => c.vote(g, ref, [0])).toThrow(/closed/);
    for (const x of [a, b, c]) {
      const poll = pollOf(x, g);
      expect(poll).toMatchObject({ closed: true, voters: 1, closedAt: ref.at + 5 * 60_000 });
      expect(poll.options.map((o) => o.votes)).toEqual([0, 1]);
    }
    // The author's PC sent the close too, for PCs that do not know about deadlines.
    expect(a.messages.pollClose(g, ref)).toBeDefined();
    await run(clock, 2_000);
    expect(c.messages.pollClose(g, ref)).toBeDefined();
  });

  it('a deadline must be at least a minute ahead, and options must differ', async () => {
    const { clock, a, g } = await office();
    expect(() =>
      a.createPoll(g, { question: 'Q', options: ['A', 'B'], closesAt: clock.now() + 1_000 }),
    ).toThrow(/closing time/);
    expect(() => a.createPoll(g, { question: 'Q', options: ['Yes', ' yes '] })).toThrow(/same/);
  });

  it('several choices, up to a limit, enforced when voting and when counting', async () => {
    const { clock, a, b, c, g } = await office();
    const ref = a.createPoll(g, {
      question: 'Which days?',
      options: ['Mon', 'Tue', 'Wed', 'Thu'],
      multi: true,
      maxChoices: 2,
    });
    await run(clock, 1_000);
    expect(() => b.vote(g, ref, [0, 1, 2])).toThrow(/up to 2/);
    expect(() => b.vote(g, ref, [7])).toThrow(/unknown option/);
    b.vote(g, ref, [0, 2]);
    c.vote(g, ref, [2, 2]);
    await run(clock, 1_000);
    for (const x of [a, b, c]) {
      const poll = pollOf(x, g);
      expect(poll.maxChoices).toBe(2);
      expect(poll.voters).toBe(2);
      expect(poll.options.map((o) => o.votes)).toEqual([1, 0, 2, 0]);
    }
    // Who chose what, by default.
    expect(pollOf(a, g).options[2]!.voters!.sort()).toEqual([b.userId, c.userId].sort());
  });

  it('names hidden, and results shown only after voting or only when closed', async () => {
    const { clock, a, b, c, g } = await office();
    const secret = a.createPoll(g, {
      question: 'Rate the offsite',
      options: ['Good', 'Bad'],
      anonymous: true,
      results: 'voted',
    });
    const sealed = a.createPoll(g, {
      question: 'Next team lead?',
      options: ['Ann', 'Ben'],
      results: 'closed',
    });
    await run(clock, 1_000);
    b.vote(g, secret, [0]);
    b.vote(g, sealed, [1]);
    await run(clock, 1_000);
    const view = (x: Core, ref: { author: string; seq: number }) =>
      x.listMessages(g).find((m) => m.author === ref.author && m.seq === ref.seq)!.poll!;

    // Anonymous: counts for those who voted, but never names.
    expect(view(b, secret)).toMatchObject({ anonymous: true, voters: 1 });
    expect(view(b, secret).options.map((o) => o.votes)).toEqual([1, 0]);
    expect(view(b, secret).options.every((o) => o.voters === undefined)).toBe(true);
    // Carol has not voted: she sees how many voted, not what.
    expect(view(c, secret)).toMatchObject({ hidden: 'voted', voters: 1 });
    expect(view(c, secret).options.map((o) => o.votes)).toEqual([0, 0]);
    // The author always sees the counts.
    expect(view(a, secret).options.map((o) => o.votes)).toEqual([1, 0]);

    // Results when closed: hidden even from a voter, until the author closes it.
    expect(view(b, sealed)).toMatchObject({ hidden: 'closed', voters: 1 });
    expect(view(b, sealed).options[1]).toMatchObject({ votes: 0, mine: true });
    a.closePoll(g, sealed);
    await run(clock, 1_000);
    for (const x of [a, b, c]) {
      expect(view(x, sealed).hidden).toBeUndefined();
      expect(view(x, sealed).options.map((o) => o.votes)).toEqual([0, 1]);
      expect(view(x, sealed).options[1]!.voters).toEqual([b.userId]);
    }
  });

  it('a poll made by an older version (no new fields) behaves as before', async () => {
    const { clock, a, b, g } = await office();
    const ref = a.createPoll(g, { question: 'Tea or coffee?', options: ['Tea', 'Coffee'] });
    await run(clock, 1_000);
    b.vote(g, ref, [0]);
    await run(clock, 1_000);
    const poll = pollOf(a, g);
    expect(poll).toEqual({
      question: 'Tea or coffee?',
      multi: false,
      closed: false,
      voters: 1,
      options: [
        { text: 'Tea', votes: 1, mine: false, voters: [b.userId] },
        { text: 'Coffee', votes: 0, mine: false, voters: [] },
      ],
    });
  });
});

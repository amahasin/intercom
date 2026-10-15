import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { allKnowEachOther, run, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function lan(count: number) {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count, clock });
  sims.push(sim);
  const cores = sim.peers.map((p) => p.core) as Core[];
  await until(clock, () => allKnowEachOther(cores), 20_000);
  return { clock, sim, cores };
}

const channel = (core: Core) => core.conversationList().find((c) => c.broadcast);

describe('M6.21 the broadcast channel', () => {
  it('is one chat, the same on every PC, with everyone in it', async () => {
    const { clock, cores } = await lan(3);
    await run(clock, 500);
    const ids = cores.map((c) => channel(c)?.convId);
    // Made without anyone creating it, with the same ID everywhere.
    expect(ids[0]).toBeDefined();
    expect(new Set(ids).size).toBe(1);
    for (const c of cores) {
      expect(channel(c)).toMatchObject({
        kind: 'group',
        title: 'Broadcast',
        broadcast: true,
        memberCount: 3,
        active: true,
      });
    }
  });

  it('a message there reaches everyone, from anyone, and replies are in the same place', async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    await run(clock, 500);
    const conv = channel(alice)!.convId;
    alice.sendMessage(conv, 'The printer on 3 is out of paper');
    await until(clock, () => [bob, carol].every((c) => c.listMessages(conv).length === 1), 8_000);
    bob.sendMessage(conv, 'Refilled it');
    await until(clock, () => cores.every((c) => c.listMessages(conv).length === 2), 8_000);
    for (const c of cores)
      expect(c.listMessages(conv).map((m) => m.text)).toEqual([
        'The printer on 3 is out of paper',
        'Refilled it',
      ]);
    // It is the same conversation for each, so unread counts and the rest work as in any chat.
    expect(carol.conversationList().find((c) => c.convId === conv)?.unread).toBe(2);
    // And nobody is bothered with a second copy in their direct chats.
    expect(bob.conversationList().filter((c) => c.kind === 'direct')).toHaveLength(0);
  });

  it('someone who was away has it when they are back, and a newcomer has the history', async () => {
    const { clock, sim, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    await run(clock, 500);
    const conv = channel(alice)!.convId;
    sim.unplug(2);
    await run(clock, 500);
    alice.sendMessage(conv, 'Fire drill at 11');
    await until(clock, () => bob.listMessages(conv).length === 1, 8_000);
    expect(carol.listMessages(conv)).toHaveLength(0);
    sim.replug(2);
    await until(clock, () => carol.listMessages(conv).length === 1, 120_000);
    expect(carol.listMessages(conv)[0]!.text).toBe('Fire drill at 11');
  });

  it('is not a group: no members to add, no rename, no leaving, no read receipts, no details', async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    await run(clock, 500);
    const conv = channel(alice)!.convId;
    expect(() => alice.addMembers(conv, [carol.userId])).toThrow(/broadcast/);
    expect(() => alice.removeMember(conv, bob.userId)).toThrow(/broadcast/);
    expect(() => alice.leave(conv)).toThrow(/broadcast/);
    expect(() => alice.renameConversation(conv, 'Mine')).toThrow(/group chats/);
    const sent = alice.sendMessage(conv, 'hello everyone');
    await until(clock, () => bob.listMessages(conv).length === 1, 8_000);
    bob.setUiState({ activeConvId: conv, windowFocused: true });
    await run(clock, 3_000);
    // Reading it tells nobody: a broadcast is not a message to one person.
    expect(alice.listMessages(conv)[0]?.status).not.toBe('read');
    expect(alice.messageDetails(conv, sent).recipients).toBeUndefined();
    // It is not one of the groups two colleagues share.
    expect(alice.personActivity(bob.userId).groups).toEqual([]);
  });
});

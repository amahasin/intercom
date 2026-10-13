import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { allKnowEachOther, run, settle, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

describe('M6.3 delete a chat', () => {
  it('removes the history on this PC only; a new message starts the chat again', async () => {
    const clock = new FakeClock();
    const sim = await startInProcessPeers({ count: 2, clock });
    sims.push(sim);
    const [alice, bob] = [sim.peers[0]!.core, sim.peers[1]!.core];
    await until(clock, () => allKnowEachOther([alice, bob]), 10_000);
    const conv = alice.openDirect(bob.userId).convId;
    for (const text of ['one', 'two', 'three']) {
      alice.sendMessage(conv, text);
      await settle();
    }
    await until(clock, () => bob.listMessages(conv, 50).length === 3, 5_000);
    bob.react(conv, { author: alice.userId, seq: 1 }, '👍', true);
    await run(clock, 500);

    // Bob deletes the chat.
    bob.deleteChat(conv);
    expect(bob.listMessages(conv, 50)).toEqual([]);
    expect(bob.conversationList().find((c) => c.convId === conv)?.lastMessage).toBeUndefined();
    expect(bob.activity().filter((a) => a.convId === conv)).toEqual([]);
    // Alice keeps everything.
    expect(alice.listMessages(conv, 50)).toHaveLength(3);

    // Time passes and the two sync again: nothing comes back.
    await run(clock, 20_000);
    expect(bob.listMessages(conv, 50)).toEqual([]);

    // A new message starts the chat again, with only what is new.
    alice.sendMessage(conv, 'four');
    await until(clock, () => bob.listMessages(conv, 50).length === 1, 5_000);
    expect(bob.listMessages(conv, 50).map((m) => m.text)).toEqual(['four']);

    // Channels are not chats to delete.
    expect(() => bob.deleteChat('no-such-conversation')).toThrow();
  });
});

describe('M6.3 remove a colleague from the list', () => {
  it('only an offline colleague can be removed; they return when seen online again', async () => {
    const clock = new FakeClock();
    const sim = await startInProcessPeers({ count: 2, clock });
    sims.push(sim);
    const [alice, bob] = [sim.peers[0]!.core, sim.peers[1]!.core];
    await until(clock, () => allKnowEachOther([alice, bob]), 10_000);
    const seen = () => alice.people().find((p) => p.userId === bob.userId)!;
    expect(seen()).toMatchObject({ online: true, hidden: false });
    expect(typeof seen().firstSeen).toBe('number');

    // Bob is online: refused (nothing changes).
    expect(alice.hidePeople([bob.userId], true)).toEqual([]);
    expect(seen().hidden).toBe(false);

    // Bob's PC goes away; Alice's list notices, and she can remove him.
    await bob.close();
    await until(clock, () => !seen().online, 120_000);
    expect(alice.hidePeople([bob.userId], true).map((p) => p.userId)).toEqual([bob.userId]);
    expect(seen().hidden).toBe(true);
    // Putting him back works too.
    alice.hidePeople([bob.userId], false);
    expect(seen().hidden).toBe(false);
  });
});

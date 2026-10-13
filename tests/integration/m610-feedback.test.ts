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
  const cores = sim.peers.map((p) => p.core);
  await until(clock, () => allKnowEachOther(cores), 20_000);
  return { clock, cores };
}

const personOf = (viewer: Core, who: Core) => viewer.people().find((p) => p.userId === who.userId);

describe('M6.10 follow-up: In a call', () => {
  it('a colleague in a call is shown as in a call (Busy for builds that do not know it), and back after it', async () => {
    const { clock, cores } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    expect(personOf(bob, alice)?.inCall).toBeUndefined();
    const dm = alice.openDirect(bob.userId).convId;
    bob.openDirect(alice.userId);
    const call = alice.startCall({ convId: dm, userIds: [bob.userId], media: 'audio' });
    await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
    bob.acceptCall(call.callId, false);
    await until(clock, () => personOf(bob, alice)?.inCall === true, 8_000);
    // The wire still says busy: older builds show Busy.
    expect(personOf(bob, alice)).toMatchObject({ presence: 'busy', inCall: true });
    expect(alice.presenceView().inCall).toBe(true);

    alice.hangupCall(call.callId);
    await until(clock, () => personOf(bob, alice)?.inCall === undefined, 8_000);
    expect(personOf(bob, alice)?.presence).toBe('available');
  });
});

describe('M6.10 follow-up: a group picture', () => {
  it('any member sets it, everybody sees it, empty takes it away, and the name is left alone', async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    const group = alice.createGroup([bob.userId, carol.userId], 'Project').convId;
    await until(
      clock,
      () => [bob, carol].every((c) => c.conversationList().some((v) => v.convId === group)),
      5_000,
    );
    const view = (c: Core) => c.conversationList().find((v) => v.convId === group)!;
    expect(view(carol).picture).toBeUndefined();

    const jpeg = Buffer.from('not a real picture, only bytes').toString('base64');
    bob.setGroupPicture(group, jpeg);
    await until(clock, () => [alice, carol].every((c) => view(c).picture === jpeg), 5_000);
    expect(view(carol).title).toBe('Project');

    // A rename afterwards keeps the picture.
    alice.renameConversation(group, 'Project X');
    await until(clock, () => view(carol).title === 'Project X', 5_000);
    expect(view(carol).picture).toBe(jpeg);

    carol.setGroupPicture(group, '');
    await until(clock, () => [alice, bob].every((c) => view(c).picture === undefined), 5_000);

    // Too big, and not for a chat of two.
    expect(() => carol.setGroupPicture(group, 'x'.repeat(40_001))).toThrow(/too big/);
    const dm = alice.openDirect(bob.userId).convId;
    expect(() => alice.setGroupPicture(dm, jpeg)).toThrow(/group/);
  });
});

describe('M6.10 follow-up: a deleted message keeps nothing it was sent with', () => {
  it('urgent, quote and mention are gone with the text', async () => {
    const { clock, cores } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const dm = alice.openDirect(bob.userId).convId;
    bob.openDirect(alice.userId);
    const first = alice.sendMessage(dm, 'first');
    await until(clock, () => bob.listMessages(dm).length === 1, 5_000);
    await run(clock, 300);
    const sent = bob.sendMessage(dm, 'please read @alice', {
      urgent: true,
      replyTo: { author: first.author, seq: first.seq },
    });
    await until(clock, () => alice.listMessages(dm).length === 2, 5_000);
    const before = alice
      .listMessages(dm)
      .find((m) => m.seq === sent.seq && m.author === sent.author)!;
    expect(before).toMatchObject({ urgent: true });
    expect(before.replyTo).toBeDefined();

    bob.deleteMessage(dm, { author: sent.author, seq: sent.seq });
    await until(
      clock,
      () =>
        alice.listMessages(dm).find((m) => m.author === sent.author && m.seq === sent.seq)
          ?.deleted === true,
      5_000,
    );
    const after = alice
      .listMessages(dm)
      .find((m) => m.author === sent.author && m.seq === sent.seq)!;
    expect(after.urgent).toBe(false);
    expect(after.mentionsMe).toBe(false);
    expect(after.replyTo).toBeUndefined();
    expect(after.text).toBe('');
  });
});

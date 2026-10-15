import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import type { CallView, IpcEventPayload } from '@officemesh/protocol/ipc';
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
  for (const c of cores)
    (c as unknown as { options: { host: object } }).options.host = {
      fixFirewall: async () => {},
      openNetworkSettings: () => {},
      notify: () => {},
    };
  return { clock, cores };
}

const ids = (call: CallView | null) => (call?.participants.map((p) => p.userId) ?? []).sort();

/** Alice calls Bob from their chat; Carol (and Dave) are added once they are talking. */
async function threeWayCall(clock: FakeClock, cores: Core[]) {
  const [alice, bob, carol] = cores as [Core, Core, Core];
  const dm = alice.openDirect(bob.userId).convId;
  bob.openDirect(alice.userId);
  const call = alice.startCall({ convId: dm, userIds: [bob.userId], media: 'audio' });
  await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
  bob.acceptCall(call.callId, false);
  await until(clock, () => alice.currentCall()?.state === 'active', 3_000);
  await run(clock, 500);
  alice.inviteToCall(call.callId, [carol.userId]);
  await until(clock, () => carol.currentCall()?.state === 'ringing', 3_000);
  carol.acceptCall(call.callId, false);
  const three = [alice, bob, carol].map((c) => c.userId).sort();
  await until(
    clock,
    () => [alice, bob, carol].every((c) => ids(c.currentCall()).join() === three.join()),
    5_000,
  );
  return { alice, bob, carol, dm, callId: call.callId };
}

const listed = (core: Core, convId: string) =>
  core.conversationList().find((c) => c.convId === convId);

describe('M6.8 leaving and ending a call', () => {
  it('leaving takes out only the person who leaves; only the organiser can end it for everyone', async () => {
    const { clock, cores } = await lan(3);
    const { alice, bob, carol, callId } = await threeWayCall(clock, cores);
    // Someone who is not the organiser cannot end it for the others.
    expect(() => bob.endCallForAll(callId)).toThrow(/organiser/);
    expect(carol.currentCall()).not.toBeNull();

    // Bob leaves: Alice and Carol stay in, and the call goes on.
    bob.hangupCall(callId);
    await until(
      clock,
      () =>
        [alice, carol].every(
          (c) => ids(c.currentCall()).join() === [alice.userId, carol.userId].sort().join(),
        ),
      5_000,
    );
    expect(bob.currentCall()).toBeNull();
    expect(alice.currentCall()).not.toBeNull();
    expect(carol.currentCall()).not.toBeNull();
  });

  it('the organiser ends the call for everyone', async () => {
    const { clock, cores } = await lan(3);
    const { alice, bob, carol, callId } = await threeWayCall(clock, cores);
    const seen: Array<IpcEventPayload<'call.controlled'>> = [];
    for (const c of [bob, carol])
      c.onEvent((n, p) => n === 'call.controlled' && seen.push(p as never));
    const ended: string[] = [];
    for (const c of [alice, bob, carol])
      c.onEvent((n, p) => {
        if (n === 'call.ended') ended.push(`${c.userId}:${(p as { outcome: string }).outcome}`);
      });

    alice.endCallForAll(callId);
    await until(clock, () => [alice, bob, carol].every((c) => c.currentCall() === null), 5_000);
    expect(seen.map((s) => s.action)).toEqual(['end', 'end']);
    expect(ended).toHaveLength(3);
    expect(ended.every((e) => e.endsWith(':completed'))).toBe(true);
    expect(alice.callHistoryItems()[0]?.outcome).toBe('completed');
    expect(bob.callHistoryItems()[0]?.outcome).toBe('completed');
  });

  it('when the organiser leaves, the person who has been in longest takes over', async () => {
    const { clock, cores } = await lan(3);
    const { alice, bob, carol, callId } = await threeWayCall(clock, cores);
    alice.hangupCall(callId);
    await until(
      clock,
      () =>
        bob.currentCall()?.organizer === bob.userId &&
        carol.currentCall()?.organizer === bob.userId,
      5_000,
    );
    expect(ids(bob.currentCall())).toEqual([bob.userId, carol.userId].sort());
    // The new organiser has the organiser's powers.
    bob.endCallForAll(callId);
    await until(clock, () => carol.currentCall() === null, 5_000);
  });
});

describe('M6.8 the temporary chat of a call that grows past two people', () => {
  it('a call of two keeps its direct chat; the third person starts a hidden group for everyone', async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    const dm = alice.openDirect(bob.userId).convId;
    bob.openDirect(alice.userId);
    const call = alice.startCall({ convId: dm, userIds: [bob.userId], media: 'audio' });
    await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
    bob.acceptCall(call.callId, false);
    await until(clock, () => alice.currentCall()?.state === 'active', 3_000);
    await run(clock, 1_000);
    // Two people: the chat is the direct chat; no group was made.
    expect(alice.currentCall()?.chat).toBeUndefined();
    expect(alice.conversationList().filter((c) => c.kind === 'group' && !c.broadcast)).toHaveLength(
      0,
    );

    // Every list update any PC gets about a group while the call goes on.
    const groupUpdates: Array<{ who: string; temporary: boolean | undefined }> = [];
    for (const c of [alice, bob, carol])
      c.onEvent((n, p) => {
        if (n !== 'conversations.changed') return;
        for (const v of (p as { conversations: Array<{ kind: string; temporary?: boolean }> })
          .conversations)
          if (v.kind === 'group') groupUpdates.push({ who: c.userId, temporary: v.temporary });
      });
    alice.inviteToCall(call.callId, [carol.userId]);
    await until(clock, () => carol.currentCall()?.state === 'ringing', 3_000);
    carol.acceptCall(call.callId, false);
    await until(
      clock,
      () => [alice, bob, carol].every((c) => c.currentCall()?.chat !== undefined),
      8_000,
    );
    const chat = alice.currentCall()!.chat!;
    // The group never showed up in a chat list, not even for an instant, on any of the three.
    expect(groupUpdates.length).toBeGreaterThan(0);
    expect(groupUpdates.filter((u) => u.temporary !== true)).toEqual([]);
    // One chat, the same for all three, with all three in it.
    expect(bob.currentCall()?.chat).toBe(chat);
    expect(carol.currentCall()?.chat).toBe(chat);
    await until(
      clock,
      () => [alice, bob, carol].every((c) => c.conversationMembers(chat).length === 3),
      8_000,
    );
    // Hidden from every chat list while the call goes on, and the direct chat is untouched.
    for (const c of [alice, bob, carol]) {
      expect(listed(c, chat)).toMatchObject({ kind: 'group', temporary: true, unread: 0 });
    }
    expect(listed(alice, dm)?.temporary).toBeUndefined();
    expect(carol.totalUnread()).toBe(0);
  });

  it('a chat nobody wrote in is never shown, however the call ends', async () => {
    const { clock, cores } = await lan(3);
    const { alice, bob, carol, callId } = await threeWayCall(clock, cores);
    await until(clock, () => alice.currentCall()?.chat !== undefined, 8_000);
    const chat = alice.currentCall()!.chat!;
    await until(
      clock,
      () => [alice, bob, carol].every((c) => c.currentCall()?.chat === chat),
      8_000,
    );
    alice.endCallForAll(callId);
    await until(clock, () => [alice, bob, carol].every((c) => c.currentCall() === null), 5_000);
    await run(clock, 500);
    for (const c of [alice, bob, carol]) {
      expect(c.callChats.get(chat)).toMatchObject({ state: 'discarded', interacted: false });
      expect(listed(c, chat)?.temporary).toBe(true);
    }
  });

  it("a chat somebody wrote in joins everyone's list when the call ends, with what was said", async () => {
    const { clock, cores } = await lan(3);
    const { alice, bob, carol, callId } = await threeWayCall(clock, cores);
    await until(
      clock,
      () => [alice, bob, carol].every((c) => c.currentCall()?.chat !== undefined),
      8_000,
    );
    const chat = alice.currentCall()!.chat!;
    await until(
      clock,
      () => [alice, bob, carol].every((c) => c.conversationMembers(chat).length === 3),
      8_000,
    );
    bob.sendMessage(chat, 'agenda: budget first');
    // A moment apart, so the order they were said in is the order they are shown in.
    await run(clock, 300);
    carol.sendMessage(chat, 'ok');
    await until(
      clock,
      () => [alice, bob, carol].every((c) => c.listMessages(chat).length === 2),
      5_000,
    );
    // Still out of the list while the call is on.
    expect(listed(alice, chat)?.temporary).toBe(true);

    alice.endCallForAll(callId);
    await until(clock, () => [alice, bob, carol].every((c) => c.currentCall() === null), 5_000);
    await run(clock, 500);
    for (const c of [alice, bob, carol]) {
      expect(c.callChats.get(chat)).toMatchObject({ state: 'kept', interacted: true });
      const view = listed(c, chat);
      expect(view).toBeDefined();
      expect(view?.temporary).toBeUndefined();
      expect(c.listMessages(chat).map((m) => m.text)).toEqual(['agenda: budget first', 'ok']);
    }
    // And it is an ordinary group from now on.
    alice.sendMessage(chat, 'minutes follow');
    await until(clock, () => bob.listMessages(chat).length === 3, 5_000);
  });

  it('a message that comes after a PC has already discarded the chat brings it back', async () => {
    const { clock, cores } = await lan(3);
    const { alice, bob, carol, callId } = await threeWayCall(clock, cores);
    await until(
      clock,
      () => [alice, bob, carol].every((c) => c.currentCall()?.chat !== undefined),
      8_000,
    );
    const chat = alice.currentCall()!.chat!;
    await until(
      clock,
      () => [alice, bob, carol].every((c) => c.conversationMembers(chat).length === 3),
      8_000,
    );
    // Bob leaves with nothing said: for him the chat is discarded ...
    bob.hangupCall(callId);
    await run(clock, 500);
    expect(bob.callChats.get(chat)?.state).toBe('discarded');
    // ... then Carol writes in it before the call is over for her: it comes back for Bob.
    carol.sendMessage(chat, 'one more thing');
    await until(clock, () => bob.callChats.get(chat)?.state === 'kept', 5_000);
    expect(listed(bob, chat)?.temporary).toBeUndefined();
  });
});

describe('M6.10 joining a group call from the group chat', () => {
  it('a call made from a group leaves a card; a member who turned the ring down can join from it', async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    const group = alice.createGroup([bob.userId, carol.userId], 'Project').convId;
    await until(
      clock,
      () => [bob, carol].every((c) => c.conversationList().some((v) => v.convId === group)),
      5_000,
    );
    const call = alice.startCall({
      convId: group,
      userIds: [bob.userId, carol.userId],
      media: 'audio',
    });
    await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
    // The card is in the group for everyone, and says a call is going on.
    await until(
      clock,
      () => [bob, carol].every((c) => c.listMessages(group).some((m) => m.callCard)),
      5_000,
    );
    const card = (c: Core) => c.listMessages(group).find((m) => m.callCard)!;
    expect(card(carol).callCard?.callId).toBe(call.callId);
    expect(card(carol).callCard?.ended).toBe(false);

    bob.acceptCall(call.callId, false);
    // Carol turned the ring down ...
    carol.declineCall(call.callId);
    await until(clock, () => carol.currentCall() === null, 3_000);
    // ... and joins from the group chat later.
    await carol.joinCall(group, { author: card(carol).author, seq: card(carol).seq });
    const here = [alice, bob, carol].map((c) => c.userId).sort();
    await until(
      clock,
      () => [alice, bob, carol].every((c) => ids(c.currentCall()).join() === here.join()),
      8_000,
    );

    // When the last person leaves the call, the card says it is over.
    for (const c of [alice, bob, carol]) {
      c.hangupCall(call.callId);
      await run(clock, 500);
    }
    await until(clock, () => carol.listMessages(group).some((m) => m.callCard?.ended), 5_000);
    await expect(
      alice.joinCall(group, { author: card(alice).author, seq: card(alice).seq }),
    ).rejects.toThrow(/ended/);
  });

  it('a call between two does not leave a card (nobody is left out of it)', async () => {
    const { clock, cores } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const dm = alice.openDirect(bob.userId).convId;
    alice.startCall({ convId: dm, userIds: [bob.userId], media: 'audio' });
    await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
    await run(clock, 500);
    expect(alice.listMessages(dm).some((m) => m.callCard)).toBe(false);
  });
});

describe('M6.21 the same people calling again use the same chat', () => {
  const callChatOf = async (clock: FakeClock, cores: Core[]) => {
    await until(clock, () => cores.every((c) => c.currentCall()?.chat), 8_000);
    return (cores[0] as Core).currentCall()!.chat!;
  };
  const endIt = async (clock: FakeClock, cores: Core[], callId: string) => {
    (cores[0] as Core).endCallForAll(callId);
    await until(clock, () => cores.every((c) => c.currentCall() === null), 5_000);
    await run(clock, 500);
  };
  const groups = (c: Core) =>
    c.conversationList().filter((v) => v.kind === 'group' && !v.broadcast);

  it("a chat nobody wrote in is not one of the groups two colleagues 'share', and the next call reuses it", async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    const first = await threeWayCall(clock, cores);
    const chat = await callChatOf(clock, cores);
    await endIt(clock, cores, first.callId);
    expect(alice.callChats.get(chat)?.state).toBe('discarded');
    // Nothing was said in it: it is not a group the two of them have.
    expect(alice.personActivity(bob.userId).groups).toEqual([]);

    // The same three, again: the same chat comes back instead of another being made.
    const second = await threeWayCall(clock, cores);
    expect(await callChatOf(clock, cores)).toBe(chat);
    for (const c of [alice, bob, carol]) {
      expect(c.currentCall()?.chat).toBe(chat);
      expect(groups(c)).toHaveLength(1);
      expect(c.callChats.get(chat)?.state).toBe('active');
      expect(listed(c, chat)?.temporary).toBe(true);
    }
    await endIt(clock, cores, second.callId);
    for (const c of [alice, bob, carol]) {
      expect(c.callChats.get(chat)?.state).toBe('discarded');
      expect(groups(c)).toHaveLength(1);
    }
    expect(alice.personActivity(carol.userId).groups).toEqual([]);
  });

  it('a chat that was written in stays the one for those people, and is a group they share', async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    const first = await threeWayCall(clock, cores);
    const chat = await callChatOf(clock, cores);
    await until(
      clock,
      () => [alice, bob, carol].every((c) => c.conversationMembers(chat).length === 3),
      8_000,
    );
    bob.sendMessage(chat, 'agenda');
    await until(clock, () => alice.listMessages(chat).length === 1, 5_000);
    await endIt(clock, cores, first.callId);
    expect(alice.personActivity(bob.userId).groups).toHaveLength(1);

    const second = await threeWayCall(clock, cores);
    expect(await callChatOf(clock, cores)).toBe(chat);
    // It stays in the list (it was kept), and nothing new was made.
    for (const c of [alice, bob, carol]) {
      expect(groups(c)).toHaveLength(1);
      expect(listed(c, chat)?.temporary).toBeUndefined();
    }
    await endIt(clock, cores, second.callId);
    expect(alice.personActivity(bob.userId).groups).toHaveLength(1);
  });

  it('a group someone made themselves with the same people is left alone', async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    const mine = alice.createGroup([bob.userId, carol.userId], 'Design').convId;
    await run(clock, 2_000);
    const first = await threeWayCall(clock, cores);
    const chat = await callChatOf(clock, cores);
    // Their own group is not the call's chat: it is not hidden, not discarded, not grown.
    expect(chat).not.toBe(mine);
    expect(alice.callChats.get(mine)).toBeUndefined();
    expect(listed(alice, mine)?.temporary).toBeUndefined();
    await endIt(clock, cores, first.callId);
    expect(alice.callChats.get(mine)).toBeUndefined();
    // They share their own group (and not the call's empty chat).
    expect(alice.personActivity(bob.userId).groups.map((g) => g.convId)).toEqual([mine]);
  });
});

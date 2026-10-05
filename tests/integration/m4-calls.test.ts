import { afterEach, describe, expect, it } from 'vitest';
import type { Core, Toast } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import type { CallView, IpcEventPayload } from '@officemesh/protocol/ipc';
import { allKnowEachOther, run, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

/** A minimal SDP with a DTLS fingerprint, as the renderer would hand over. */
const sdp = (tag: string) =>
  `v=0\r\no=- ${tag} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 AA:BB:${tag}\r\n`;

async function lan(count: number) {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count, clock });
  sims.push(sim);
  const cores = sim.peers.map((p) => p.core);
  await until(clock, () => allKnowEachOther(cores), 20_000);
  const toasts = new Map<Core, Toast[]>();
  for (const c of cores) {
    const list: Toast[] = [];
    toasts.set(c, list);
    (c as unknown as { options: { host: object } }).options.host = {
      fixFirewall: async () => {},
      openNetworkSettings: () => {},
      notify: (t: Toast) => list.push(t),
    };
  }
  return { clock, sim, cores, toasts };
}

function watch(core: Core) {
  const ended: Array<IpcEventPayload<'call.ended'>> = [];
  const signals: Array<IpcEventPayload<'call.signal'>> = [];
  core.onEvent((name, payload) => {
    if (name === 'call.ended') ended.push(payload as IpcEventPayload<'call.ended'>);
    if (name === 'call.signal') signals.push(payload as IpcEventPayload<'call.signal'>);
  });
  return { ended, signals };
}

const ids = (call: CallView | null) => (call?.participants.map((p) => p.userId) ?? []).sort();

describe('M4 call signaling', () => {
  it('rings, answers, and relays signed SDP and ICE between the two PCs', async () => {
    const { clock, cores, toasts } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const bobSeen = watch(bob);
    const aliceSeen = watch(alice);
    const conv = alice.openDirect(bob.userId).convId;
    const call = alice.startCall({ convId: conv, userIds: [bob.userId], media: 'video' });
    expect(call.state).toBe('outgoing');
    await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
    expect(bob.currentCall()).toMatchObject({
      direction: 'in',
      caller: alice.userId,
      media: 'video',
    });
    expect(toasts.get(bob)!.at(-1)).toMatchObject({ call: true, title: 'Incoming video call' });

    bob.acceptCall(call.callId, true);
    await until(clock, () => alice.currentCall()?.state === 'active', 3_000);
    expect(ids(alice.currentCall())).toEqual([alice.userId, bob.userId].sort());
    expect(ids(bob.currentCall())).toEqual([alice.userId, bob.userId].sort());

    // The newcomer offers; SDP travels signed and arrives intact.
    bob.callSignal(call.callId, alice.userId, { kind: 'sdp', type: 'offer', sdp: sdp('bob') });
    alice.callSignal(call.callId, bob.userId, { kind: 'sdp', type: 'answer', sdp: sdp('alice') });
    alice.callSignal(call.callId, bob.userId, {
      kind: 'ice',
      candidate: { candidate: 'candidate:1 1 udp 2122260223 10.0.0.1 50000 typ host', sdpMid: '0' },
    });
    await run(clock, 300);
    expect(aliceSeen.signals).toEqual([
      {
        callId: call.callId,
        from: bob.userId,
        signal: { kind: 'sdp', type: 'offer', sdp: sdp('bob') },
      },
    ]);
    expect(bobSeen.signals.map((s) => s.signal.kind)).toEqual(['sdp', 'ice']);

    // An SDP without a DTLS fingerprint is refused before it leaves.
    expect(() =>
      bob.callSignal(call.callId, alice.userId, { kind: 'sdp', type: 'offer', sdp: 'v=0\r\n' }),
    ).toThrow(/fingerprint/);

    // Mute travels in the roster.
    bob.updateCall(call.callId, { muted: true });
    await run(clock, 300);
    expect(alice.currentCall()!.participants.find((p) => p.userId === bob.userId)?.muted).toBe(
      true,
    );
    // In a call, Available shows as Busy.
    expect(alice.presenceView().effective).toBe('busy');

    bob.hangupCall(call.callId);
    await until(clock, () => alice.currentCall() === null, 3_000);
    expect(aliceSeen.ended.at(-1)?.outcome).toBe('completed');
    expect(alice.callHistoryItems()[0]).toMatchObject({ direction: 'out', outcome: 'completed' });
    expect(bob.callHistoryItems()[0]).toMatchObject({ direction: 'in', outcome: 'completed' });
    expect(alice.presenceView().effective).toBe('available');
  });

  it('rejects an SDP whose signature does not match the sender', async () => {
    const { clock, cores } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const aliceSeen = watch(alice);
    const call = alice.startCall({ userIds: [bob.userId], media: 'audio' });
    await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
    bob.acceptCall(call.callId, false);
    await until(clock, () => alice.currentCall()?.state === 'active', 3_000);
    // Bob's PC sends an SDP with a forged signature straight over the link.
    bob.network!.links.send(alice.userId, 'call.sdp', {
      callId: call.callId,
      from: bob.userId,
      to: alice.userId,
      type: 'offer',
      sdp: sdp('evil'),
      fingerprint: 'sha-256 AA:BB:evil',
      sig: 'A'.repeat(86),
    });
    await run(clock, 300);
    expect(aliceSeen.signals).toEqual([]);
  });

  it('a callee in Do not disturb is not rung, and the caller sees why', async () => {
    const { clock, cores, toasts } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const aliceSeen = watch(alice);
    bob.setPresence('dnd');
    alice.startCall({ userIds: [bob.userId], media: 'video' });
    await until(clock, () => alice.currentCall() === null, 3_000);
    expect(aliceSeen.ended.at(-1)).toMatchObject({
      outcome: 'dnd',
      declines: [{ userId: bob.userId, reason: 'dnd' }],
    });
    expect(bob.currentCall()).toBeNull();
    expect(toasts.get(bob)).toEqual([]);
    expect(bob.activity()[0]).toMatchObject({ kind: 'missed-call', author: alice.userId });
    expect(bob.callHistoryItems()[0]).toMatchObject({ direction: 'in', outcome: 'dnd' });
    expect(alice.callHistoryItems()[0]).toMatchObject({ direction: 'out', outcome: 'dnd' });
  });

  it('a callee already in a call declines as busy', async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    const carolSeen = watch(carol);
    const first = alice.startCall({ userIds: [bob.userId], media: 'audio' });
    await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
    bob.acceptCall(first.callId, false);
    await until(clock, () => alice.currentCall()?.state === 'active', 3_000);
    carol.startCall({ userIds: [bob.userId], media: 'audio' });
    await until(clock, () => carol.currentCall() === null, 3_000);
    expect(carolSeen.ended.at(-1)?.outcome).toBe('busy');
    expect(bob.currentCall()?.callId).toBe(first.callId);
  });

  it('an unanswered call rings for 30 seconds, then is a missed call', async () => {
    const { clock, cores, toasts } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const aliceSeen = watch(alice);
    alice.startCall({ userIds: [bob.userId], media: 'audio' });
    await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
    await run(clock, 25_000);
    expect(bob.currentCall()?.state).toBe('ringing');
    await until(clock, () => alice.currentCall() === null && bob.currentCall() === null, 10_000);
    expect(aliceSeen.ended.at(-1)?.outcome).toBe('no-answer');
    expect(bob.callHistoryItems()[0]?.outcome).toBe('missed');
    expect(bob.activity()[0]).toMatchObject({ kind: 'missed-call', excerpt: 'Missed call' });
    expect(toasts.get(bob)!.at(-1)?.title).toBe('Missed call');
  });

  it('a caller who hangs up while ringing leaves a missed call', async () => {
    const { clock, cores } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const call = alice.startCall({ userIds: [bob.userId], media: 'audio' });
    await until(clock, () => bob.currentCall()?.state === 'ringing', 3_000);
    alice.hangupCall(call.callId);
    await until(clock, () => bob.currentCall() === null, 3_000);
    expect(alice.callHistoryItems()[0]?.outcome).toBe('cancelled');
    expect(bob.callHistoryItems()[0]?.outcome).toBe('missed');
  });

  it('group call: everyone learns the roster, a leaver and a dropped participant disappear', async () => {
    const { clock, cores } = await lan(4);
    const [alice, bob, carol, dave] = cores as [Core, Core, Core, Core];
    const call = alice.startCall({ userIds: [bob.userId, carol.userId], media: 'video' });
    await until(clock, () => bob.currentCall() !== null && carol.currentCall() !== null, 3_000);
    bob.acceptCall(call.callId, true);
    carol.acceptCall(call.callId, false);
    const everyone = [alice, bob, carol].map((c) => c.userId).sort();
    await until(
      clock,
      () => [alice, bob, carol].every((c) => ids(c.currentCall()).join() === everyone.join()),
      5_000,
    );

    // Anyone in the call can add someone; the newcomer is told who is there.
    carol.inviteToCall(call.callId, [dave.userId]);
    await until(clock, () => dave.currentCall()?.state === 'ringing', 3_000);
    expect(ids(dave.currentCall())).toEqual(everyone);
    dave.acceptCall(call.callId, true);
    const four = [...everyone, dave.userId].sort();
    await until(
      clock,
      () => [alice, bob, carol, dave].every((c) => ids(c.currentCall()).join() === four.join()),
      5_000,
    );

    carol.hangupCall(call.callId);
    const three = four.filter((u) => u !== carol.userId);
    await until(
      clock,
      () => [alice, bob, dave].every((c) => ids(c.currentCall()).join() === three.join()),
      5_000,
    );

    // Alice's media to Dave failed: Dave is dropped for everyone, and his call ends.
    alice.callDropped(call.callId, dave.userId);
    await until(clock, () => dave.currentCall() === null, 5_000);
    const two = [alice.userId, bob.userId].sort();
    await until(
      clock,
      () => [alice, bob].every((c) => ids(c.currentCall()).join() === two.join()),
      5_000,
    );

    bob.hangupCall(call.callId);
    await until(clock, () => alice.currentCall() === null, 5_000);
    expect(alice.callHistoryItems()[0]?.outcome).toBe('completed');
  });
});

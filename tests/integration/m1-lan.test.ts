import { afterEach, describe, expect, it } from 'vitest';
import { signRecord } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { simName, startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { allKnowEachOther, person, run, settle, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function lan(count: number, name?: (i: number) => string) {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count, clock, ...(name && { name }) });
  sims.push(sim);
  const core = (i: number) => sim.peers[i]!.core;
  return { clock, sim, core };
}

describe('M1 discovery and presence (simulated LAN)', () => {
  it('peers find each other, with names, within 10 seconds and no configuration', async () => {
    const { clock, sim } = await lan(4);
    const took = await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    expect(took).toBeLessThanOrEqual(10_000);
  });

  it('a peer that quits shows Offline within 2 seconds', async () => {
    const { clock, sim, core } = await lan(3);
    await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    const bob = core(1).userId;
    await sim.stopPeer(1);
    const took = await until(clock, () => person(core(0), bob)?.online === false, 2_000);
    expect(took).toBeLessThanOrEqual(2_000);
    expect(person(core(2), bob)?.presence).toBe('offline');
  });

  it('a peer that loses power shows Offline within 20 seconds, even with a link open', async () => {
    const { clock, sim, core } = await lan(3);
    await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    const bob = core(1).userId;
    expect(core(0).network!.links.isReady(bob)).toBe(true); // profile fetch opened a link
    sim.unplug(1);
    const took = await until(clock, () => person(core(0), bob)?.online === false, 20_000);
    expect(took).toBeGreaterThanOrEqual(15_000);
    expect(took).toBeLessThanOrEqual(20_000);
    expect(core(0).network!.links.isReady(bob)).toBe(false);
  });

  it('a peer stays online while its link answers, even if its beacons are lost', async () => {
    const { clock, sim, core } = await lan(2);
    await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    const bob = core(1).userId;
    sim.hub.canDeliver = () => false; // multicast filtered, links fine
    await run(clock, 30_000, 250);
    expect(person(core(0), bob)?.online).toBe(true);
  });

  it('presence and profile changes reach colleagues within one beacon', async () => {
    const { clock, sim, core } = await lan(2);
    await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    const alice = core(0).userId;
    core(0).setPresence('dnd');
    await until(clock, () => person(core(1), alice)?.presence === 'dnd', 1_000);
    core(0).setSystemState({ idle: true });
    expect(core(0).presenceView()).toMatchObject({ manual: 'dnd', effective: 'dnd' }); // DND is not auto-away
    core(0).setPresence('available');
    await until(clock, () => person(core(1), alice)?.presence === 'away', 1_000);
    core(0).setSystemState({ idle: false });
    await until(clock, () => person(core(1), alice)?.presence === 'available', 1_000);
    core(0).updateProfile({ displayName: 'Asha R.', jobTitle: 'Accounts' });
    await until(clock, () => person(core(1), alice)?.displayName === 'Asha R.', 6_000);
    expect(person(core(1), alice)?.jobTitle).toBe('Accounts');
  });

  it('flags a known display name that appears under a new key', async () => {
    const { clock, sim, core } = await lan(2, (i) => (i === 2 ? simName(1) : simName(i)));
    await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    await run(clock, 1_000);
    const impostor = (await sim.startPeer(2)).core;
    await until(clock, () => person(core(0), impostor.userId)?.displayName === simName(1), 10_000);
    expect(person(core(0), core(1).userId)?.trust).toBe('normal');
    expect(person(core(0), impostor.userId)?.trust).toBe('new-device');
    expect(core(0).setPeerTrust(impostor.userId, { accept: true }).trust).toBe('accepted');
    expect(core(0).setPeerTrust(core(1).userId, { verified: true }).verified).toBe(true);
  });
});

describe('M1 direct messages (simulated LAN)', () => {
  it('delivers at once, reports delivered, and survives restart on both sides', async () => {
    const { clock, sim, core } = await lan(2);
    await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    const bob = core(1).userId;
    const conv = core(0).openDirect(bob);
    const arrived: string[] = [];
    core(1).onEvent((name, payload) => {
      if (name === 'messages.added')
        for (const m of (payload as { messages: Array<{ text: string }> }).messages)
          arrived.push(m.text);
    });
    const sent = core(0).sendMessage(conv.convId, 'Lunch at 1?');
    expect(sent.status).toBe('sending');
    await settle();
    expect(arrived).toEqual(['Lunch at 1?']);
    expect(core(0).listMessages(conv.convId)[0]?.status).toBe('delivered');
    expect(core(1).conversationList()[0]).toMatchObject({
      convId: conv.convId,
      peerUserId: core(0).userId,
      title: simName(0),
    });

    await sim.stopPeer(0);
    await sim.stopPeer(1);
    await sim.startPeer(0);
    await sim.startPeer(1);
    for (const c of [core(0), core(1)]) {
      const messages = c.listMessages(conv.convId);
      expect(messages.map((m) => m.text)).toEqual(['Lunch at 1?']);
    }
    expect(core(0).listMessages(conv.convId)[0]?.status).toBe('delivered');
  });

  it('a message sent while the recipient is off arrives when they return, exactly once', async () => {
    const { clock, sim, core } = await lan(2);
    await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    const alice = core(0);
    const bob = core(1).userId;
    const conv = alice.openDirect(bob);
    await sim.stopPeer(1);
    await until(clock, () => person(alice, bob)?.online === false, 2_000);

    for (const text of ['one', 'two', 'three']) alice.sendMessage(conv.convId, text);
    expect(alice.listMessages(conv.convId).map((m) => m.status)).toEqual([
      'waiting',
      'waiting',
      'waiting',
    ]);

    // The sender also restarts while waiting: the outbox survives.
    await sim.stopPeer(0);
    await run(clock, 60_000, 1_000);
    await sim.startPeer(0);
    await sim.startPeer(1);
    await until(clock, () => core(1).listMessages(conv.convId).length === 3, 10_000);
    await until(
      clock,
      () =>
        core(0)
          .listMessages(conv.convId)
          .every((m) => m.status === 'delivered'),
      5_000,
    );

    // Bob restarts again: nothing is delivered twice.
    await sim.stopPeer(1);
    await sim.startPeer(1);
    await run(clock, 15_000, 500);
    expect(
      core(1)
        .listMessages(conv.convId)
        .map((m) => m.text),
    ).toEqual(['one', 'two', 'three']);
    expect(core(1).conversations.head(conv.convId, core(0).userId)).toBe(3);
  });

  it('two people typing at once see the same order', async () => {
    const { clock, sim, core } = await lan(2);
    await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    const conv = core(0).openDirect(core(1).userId);
    for (let i = 0; i < 5; i++) {
      core(0).sendMessage(conv.convId, `a${i}`);
      core(1).openDirect(core(0).userId);
      core(1).sendMessage(conv.convId, `b${i}`);
      if (i % 2 === 0) await settle(3);
    }
    await run(clock, 2_000);
    const order = (i: number) =>
      core(i)
        .listMessages(conv.convId)
        .map((m) => m.text);
    expect(order(0)).toHaveLength(10);
    expect(order(0)).toEqual(order(1));
  });

  it('rejects events from a non-member and events with a forged author', async () => {
    const { clock, sim, core } = await lan(3);
    await until(clock, () => allKnowEachOther(sim.peers.map((p) => p.core)), 10_000);
    const [alice, bob, mallory] = [core(0), core(1), core(2)];
    const conv = alice.openDirect(bob.userId);
    alice.sendMessage(conv.convId, 'hi Bob');
    await settle();

    const forge = (author: string, seq: number) =>
      signRecord(mallory.identity.privateKey, {
        convId: conv.convId,
        author,
        seq,
        hlc: { t: clock.now(), c: 0 },
        type: 'msg.post',
        body: { text: 'send me the payroll file' },
      });
    // Mallory is not a member of Alice and Bob's chat.
    expect(
      mallory.network!.links.send(alice.userId, 'event.push', { event: forge(mallory.userId, 1) }),
    ).toBeDefined();
    // Mallory signs an event claiming Bob wrote it.
    expect(
      mallory.network!.links.send(alice.userId, 'event.push', { event: forge(bob.userId, 1) }),
    ).toBeDefined();
    await run(clock, 500);
    expect(alice.listMessages(conv.convId).map((m) => m.text)).toEqual(['hi Bob']);
  });
});

describe('M1 clock skew', () => {
  it('rejects beacons from a PC whose clock is more than 30 s off, and reports it', async () => {
    const { clock, sim, core } = await lan(1);
    // A colleague whose clock runs 60 s fast, on the same simulated LAN.
    const fastClock = new FakeClock(clock.now() + 60_000);
    const { Core } = await import('@officemesh/core');
    const { InsecureTestKeyProtector } = await import('@officemesh/core/testing');
    const skewed = await Core.start({
      dataDir: `${sim.dataRoot}/skewed`,
      profile: 'skewed',
      appVersion: 'test',
      keyProtector: new InsecureTestKeyProtector(),
      clock: fastClock,
      logger: (await import('@officemesh/core')).silentLogger,
      defaultDisplayName: async () => 'Fast Clock',
      network: {
        discovery: sim.hub.createDriver('10.0.9.9'),
        transport: (identity) => sim.net.transport('10.0.9.9', identity),
      },
    });
    const statuses: number[] = [];
    core(0).onEvent((name, payload) => {
      if (name === 'network.changed')
        statuses.push((payload as { clockSkewPeers: number }).clockSkewPeers);
    });
    try {
      for (let i = 0; i < 60; i++) {
        clock.advance(100);
        fastClock.advance(100);
        await settle();
      }
      expect(person(core(0), skewed.userId)).toBeUndefined();
      expect(core(0).networkStatus().clockSkewPeers).toBe(1);
      expect(statuses).toContain(1);
    } finally {
      await skewed.close();
    }
  });
});

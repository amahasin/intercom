import * as mediasoup from 'mediasoup';
import type { types as ms } from 'mediasoup';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_CODECS, type Core } from '@officemesh/core';
import { SimMediaClient, startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import type { CallView } from '@officemesh/protocol/ipc';
import { allKnowEachOther } from './helpers.ts';

let describeState: () => string = () => '';

/** Real time: the relay's media runs in real mediasoup workers. */
async function waitFor(cond: () => boolean, maxMs: number, what = 'condition'): Promise<number> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > maxMs)
      throw new Error(`${what} not met within ${maxMs} ms\n${describeState()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return Date.now() - start;
}

let worker: ms.Worker;
let router: ms.Router;
beforeAll(async () => {
  worker = await mediasoup.createWorker({ logLevel: 'error' });
  router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
});
afterAll(() => worker.close());

const sims: InProcessSim[] = [];
const clients: SimMediaClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of sims.splice(0)) await s.stop();
});

/** Connect a simulated media client whenever the core's call is on a relay epoch it has not joined. */
function attachMedia(core: Core, mic: boolean, camera: boolean) {
  const state: { client?: SimMediaClient; epoch: number; call?: CallView | null } = { epoch: 0 };
  core.onEvent((name, payload) => {
    if (name === 'call.changed') {
      const call = (payload as { call: CallView | null }).call;
      state.call = call;
      if (!call?.relay) {
        state.client?.close();
        delete state.client;
        state.epoch = 0;
        return;
      }
      if (call.relay.reconnecting || call.relay.epoch === state.epoch) return;
      state.client?.close();
      const epoch = call.relay.epoch;
      state.epoch = epoch;
      const client = new SimMediaClient({
        router,
        ip: '127.0.0.1',
        mic,
        camera,
        request: (method, data) =>
          core.relayRequest(call.callId, epoch, method as 'capabilities', data),
      });
      client.level = mic ? 20 : 127;
      clients.push(client);
      state.client = client;
      void client.start().catch(() => {});
    } else if (name === 'call.relay') {
      const p = payload as { epoch: number; method: string; data: unknown };
      if (p.epoch === state.epoch) void state.client?.onNotify(p.method, p.data);
    }
  });
  return state;
}

describe('M6 host relay', () => {
  it('moves a growing meeting to the relay, forwards media, and hands over when the host dies', async () => {
    const scores = [2_000, 1_500, 0, 0];
    const sim = await startInProcessPeers({
      count: 4,
      coreOptions: (i) => ({
        relay: {
          score: scores[i]!,
          meshLimit: 2,
          maxWorkers: 2,
          listenIps: ['127.0.0.1'],
          allowPlain: true,
        },
      }),
    });
    sims.push(sim);
    const cores = sim.peers.map((p) => p.core);
    describeState = () =>
      cores
        .map((c, i) => {
          const call = c.currentCall();
          return `${i}: ${call?.state} relay=${JSON.stringify(call?.relay)} people=${call?.participants
            .map((p) => cores.findIndex((x) => x.userId === p.userId))
            .join(',')} invited=${call?.invited.length}`;
        })
        .join('\n');
    await waitFor(() => allKnowEachOther(cores), 20_000, 'discovery');
    const [alice, bob, carol, dan] = cores as [Core, Core, Core, Core];
    const media = cores.map((c, i) => attachMedia(c, true, i < 3));

    const group = alice.createGroup([bob.userId, carol.userId, dan.userId], 'All hands').convId;
    await waitFor(
      () => cores.every((c) => c.conversationList().some((v) => v.convId === group && v.active)),
      5_000,
      'group',
    );
    const call = await alice.meetNow(group, 'video');
    const card = () => bob.listMessages(group).find((m) => m.kindDetail === 'call');
    await waitFor(() => card() !== undefined, 5_000, 'card');
    await bob.joinCall(group, card()!);
    // Two people: still a mesh.
    expect(alice.currentCall()?.relay).toBeUndefined();

    // A third person exceeds the (test) mesh limit: everyone moves to the organiser's relay.
    await carol.joinCall(group, card()!);
    await dan.joinCall(group, card()!);
    const ids = cores.map((c) => c.userId).sort();
    const roster = (c: Core) =>
      (c.currentCall()?.participants.map((p) => p.userId) ?? []).sort().join();
    await waitFor(
      () =>
        cores.every(
          (c) =>
            c.currentCall()?.relay?.host === alice.userId &&
            c.currentCall()?.relay?.reconnecting === false &&
            roster(c) === ids.join(),
        ),
      15_000,
      'everyone on the relay',
    );
    expect(alice.relayStatus()).toMatchObject({ hosting: true, participants: 4 });

    // Media flows to everyone through the relay: three voices (the loudest 3) and cameras.
    await waitFor(
      () => media.every((m) => (m.client?.stats.bytesIn ?? 0) > 50_000),
      15_000,
      'media through the relay',
    );
    const dans = media[3]!.client!.stats;
    expect(dans.audioConsumers).toBe(3);
    expect(dans.videoConsumers).toBe(3);
    // Dan has no camera: the others each receive the 2 other cameras.
    expect(media[0]!.client!.stats.videoConsumers).toBe(2);

    // Reactions and organiser controls go through the host.
    const reactions: string[] = [];
    dan.onEvent((n, p) => n === 'call.reaction' && reactions.push((p as { emoji: string }).emoji));
    bob.reactInCall(call.callId, '👏');
    await waitFor(() => reactions.includes('👏'), 5_000, 'reaction');
    alice.controlCall(call.callId, 'mute', dan.userId);
    await waitFor(
      () => alice.currentCall()?.participants.find((p) => p.userId === dan.userId)?.muted === true,
      5_000,
      'organiser mute',
    );

    // The host's PC dies: the next strongest (Bob) takes over and everyone reconnects.
    const killedAt = Date.now();
    sim.unplug(0);
    sim.net.pullPlug(sim.peers[0]!.address);
    const others = [bob, carol, dan];
    await waitFor(
      () =>
        others.every(
          (c) =>
            c.currentCall()?.relay?.host === bob.userId &&
            c.currentCall()?.relay?.reconnecting === false,
        ),
      10_000,
      'hand-over',
    );
    const flowing = () =>
      [1, 2, 3].every((i) => (media[i]!.client?.stats.lastIn ?? 0) > killedAt + 200);
    await waitFor(flowing, 10_000, 'media after hand-over');
    const recovered = Date.now() - killedAt;
    expect(recovered).toBeLessThan(10_000);
    console.log(`relay hand-over: media flowing again after ${recovered} ms`);
    // Alice is gone from the roster; the epoch moved on.
    await waitFor(
      () =>
        roster(carol) ===
        [bob, carol, dan]
          .map((c) => c.userId)
          .sort()
          .join(),
      15_000,
      'roster after hand-over',
    );
    expect(carol.currentCall()?.relay?.epoch).toBe(2);
    expect(bob.relayStatus().hosting).toBe(true);
  }, 90_000);

  it('caps a meeting at 25 when no relay-capable PC is present, and declines with the reason', async () => {
    const sim = await startInProcessPeers({
      count: 3,
      coreOptions: (i) => ({
        relay: {
          score: i === 0 ? 8 : 0,
          meshLimit: 1,
          maxWorkers: 1,
          listenIps: ['127.0.0.1'],
          allowPlain: true,
        },
      }),
    });
    sims.push(sim);
    const cores = sim.peers.map((p) => p.core);
    await waitFor(() => allKnowEachOther(cores), 20_000, 'discovery');
    const [alice, bob] = cores as [Core, Core, Core];
    const group = alice.createGroup([bob.userId, cores[2]!.userId]).convId;
    await waitFor(() => bob.conversationList().some((v) => v.convId === group && v.active), 5_000);
    await alice.meetNow(group, 'audio');
    const card = () => bob.listMessages(group).find((m) => m.kindDetail === 'call');
    await waitFor(() => card() !== undefined, 5_000);
    await bob.joinCall(group, card()!);
    await waitFor(() => bob.currentCall()?.relay?.reconnecting === false, 10_000, 'relay');
    expect(bob.currentCall()?.relay).toMatchObject({ host: alice.userId, max: 25 });
  }, 60_000);

  it('a joiner who does not fit is told the meeting is full, at once', async () => {
    // Nobody can host a relay: the meeting stays a mesh of (test limit) 2.
    const sim = await startInProcessPeers({
      count: 3,
      coreOptions: () => ({ relay: { score: 0, meshLimit: 2, listenIps: ['127.0.0.1'] } }),
    });
    sims.push(sim);
    const cores = sim.peers.map((p) => p.core);
    await waitFor(() => allKnowEachOther(cores), 20_000, 'discovery');
    const [alice, bob, carol] = cores as [Core, Core, Core];
    const group = alice.createGroup([bob.userId, carol.userId]).convId;
    await waitFor(
      () => carol.conversationList().some((v) => v.convId === group && v.active),
      5_000,
    );
    await alice.meetNow(group, 'audio');
    const card = () => carol.listMessages(group).find((m) => m.kindDetail === 'call');
    await waitFor(() => card() !== undefined, 5_000);
    await bob.joinCall(group, card()!);
    const started = Date.now();
    await expect(carol.joinCall(group, card()!)).rejects.toThrow(/full/);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(alice.currentCall()?.relay).toBeUndefined();
  }, 60_000);
});

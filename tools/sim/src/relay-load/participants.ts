/**
 * Simulated meeting participants for the relay load test: several in one process, each
 * with its own identity, mutual-TLS links and the real call manager (joining, the relay
 * star, hand-over), and simulated media (relay-media.ts) instead of a renderer.
 *
 *   node participants.ts --count=<n> --first=<index> --discovery-port=<n>
 *                        --speakers=<indices> --cameras=<indices>
 */
import * as mediasoup from 'mediasoup';
import {
  BeaconVerifier,
  CallManager,
  CallRepo,
  createSelfSignedCertificate,
  createTlsTransport,
  encodeBeacon,
  generateIdentityKeyPair,
  LinkManager,
  LOOPBACK_ONLY,
  MEDIA_CODECS,
  signProfile,
  silentLogger,
  Store,
  systemClock,
  UdpDiscoveryDriver,
  userIdFromSpki,
} from '@officemesh/core';
import { BEACON_INTERVAL_MS } from '@officemesh/protocol';
import type { CallView } from '@officemesh/protocol/ipc';
import { SimMediaClient } from '../relay-media.ts';

function arg(name: string): string {
  const v = process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (v === undefined) throw new Error(`missing --${name}=`);
  return v;
}
const list = (s: string) => new Set(s.split(',').filter(Boolean).map(Number));

const count = Number(arg('count'));
const first = Number(arg('first'));
const speakers = list(arg('speakers'));
const cameras = list(arg('cameras'));
const driver = await UdpDiscoveryDriver.open({
  port: Number(arg('discovery-port')),
  logger: silentLogger,
  interfaces: LOOPBACK_ONLY,
});

// Where colleagues are: learnt from their beacons.
const addresses = new Map<string, number>();
const verifier = new BeaconVerifier();
driver.onDatagram((d) => {
  const v = verifier.verify(d, Date.now());
  if (v.ok && v.beacon.kind === 'alive') addresses.set(v.beacon.userId, v.beacon.port);
});

const workers = await Promise.all([0, 1].map(() => mediasoup.createWorker({ logLevel: 'error' })));
const routers = await Promise.all(
  workers.map((w) => w.createRouter({ mediaCodecs: MEDIA_CODECS })),
);

interface Sim {
  index: number;
  userId: string;
  links: LinkManager;
  calls: CallManager;
  port: number;
  keys: ReturnType<typeof generateIdentityKeyPair>;
  media?: SimMediaClient;
  epoch: number;
  call: CallView | null;
}

const sims: Sim[] = await Promise.all(
  Array.from({ length: count }, async (_, k): Promise<Sim> => {
    const index = first + k;
    const keys = generateIdentityKeyPair();
    const userId = userIdFromSpki(keys.spki);
    const certPem = await createSelfSignedCertificate(userId, keys.privateKey, keys.publicKey);
    const profile = signProfile(keys.privateKey, {
      userId,
      version: 1,
      displayName: `Participant ${index}`,
      updatedAt: Date.now(),
    });
    const links = new LinkManager({
      selfId: userId,
      appVersion: 'sim-relay',
      transport: createTlsTransport(
        { privateKey: keys.privateKey, certPem },
        { port: 0, host: '127.0.0.1', logger: silentLogger },
      ),
      clock: systemClock,
      logger: silentLogger,
      caps: ['session.v1', 'profile.v1', 'calls.mesh', 'calls.meet', 'calls.relay'],
    });
    links.on('profile.get', (_f, body) =>
      (body as { userId: string }).userId === userId
        ? { type: 'profile.data', body: { profile } }
        : undefined,
    );
    const port = await links.start();
    const store = Store.open(':memory:');
    const sim = { index, userId, links, port, keys, epoch: 0, call: null } as unknown as Sim;
    sim.calls = new CallManager({
      selfId: userId,
      privateKey: keys.privateKey,
      links,
      connect: async (u) => {
        // Like a real PC, wait (a little) to hear a colleague's beacon before dialing.
        for (let i = 0; i < 60 && !addresses.has(u); i++)
          await new Promise((r) => setTimeout(r, 100));
        const p = addresses.get(u);
        return p !== undefined && (await links.ensureLink(u, '127.0.0.1', p));
      },
      keyFor: () => undefined,
      doNotDisturb: () => false,
      mayJoin: () => false,
      relayScore: () => 0,
      repo: new CallRepo(store.db),
      clock: systemClock,
      logger: silentLogger,
      events: {
        changed: (call) => onChanged(sim, call ? view(call) : null),
        ended: (call, outcome) =>
          process.send?.({
            type: 'log',
            text: `sim ${index} call ended: ${outcome} relay=${JSON.stringify(call.relay ? { h: call.relay.host.slice(0, 4), e: call.relay.epoch } : null)} state=${call.state}`,
          }),
        signal: () => {},
        incoming: () => {},
        missed: () => {},
        historyChanged: () => {},
        reaction: () => {},
        controlled: () => {},
        relay: (_callId, epoch, method, data) => {
          if (epoch === sim.epoch) void sim.media?.onNotify(method, data);
        },
      },
    });
    return sim;
  }),
);

function view(call: NonNullable<CallManager['call']>): CallView {
  return {
    callId: call.callId,
    media: call.media,
    direction: call.direction,
    state: call.state,
    caller: call.caller,
    organizer: call.organizer,
    invited: [],
    participants: [...call.roster.values()].filter((p) => !p.left).map((p) => ({ ...p, name: '' })),
    declines: [],
    startedAt: call.startedAt,
    ...(call.relay && {
      relay: {
        host: call.relay.host,
        epoch: call.relay.epoch,
        max: call.relay.max,
        reconnecting: call.relay.reconnecting,
      },
    }),
  };
}

/** Connect media whenever the call is on a relay epoch this participant has not joined. */
function onChanged(sim: Sim, call: CallView | null): void {
  sim.call = call;
  if (!call?.relay) {
    sim.media?.close();
    delete sim.media;
    sim.epoch = 0;
    return;
  }
  if (call.relay.reconnecting || call.relay.epoch === sim.epoch) return;
  sim.media?.close();
  const epoch = call.relay.epoch;
  sim.epoch = epoch;
  const media = new SimMediaClient({
    router: routers[sim.index % routers.length]!,
    ip: '127.0.0.1',
    mic: speakers.has(sim.index),
    camera: cameras.has(sim.index),
    request: (method, data) =>
      sim.calls.relayRequest(call.callId, epoch, method as 'capabilities', data),
  });
  sim.media = media;
  void media
    .start()
    .then(() => sim.calls.relayRequest(call.callId, epoch, 'setView', { layer: 1 }).catch(() => {}))
    .catch(() => {});
}

// Beacons, spread over each interval as independent PCs would send them.
let turn = 0;
setInterval(
  () => {
    const s = sims[turn++ % sims.length]!;
    driver.send(
      encodeBeacon(
        { userId: s.userId, spki: s.keys.spki, privateKey: s.keys.privateKey },
        { kind: 'alive', port: s.port, presence: 'available', profileVer: 1, ts: Date.now() },
      ),
    );
  },
  Math.max(1, Math.floor(BEACON_INTERVAL_MS / sims.length)),
);

// Three speakers are loud at a time, changing every few seconds (the host picks the
// loudest 3 and the most recent speakers' cameras).
const speakerSims = sims.filter((s) => speakers.has(s.index));
let round = 0;
setInterval(() => {
  round++;
  speakerSims.forEach((s, i) => {
    if (s.media)
      s.media.level = (i + round) % Math.max(1, Math.ceil(speakerSims.length / 3)) === 0 ? 15 : 127;
  });
}, 4_000);

type Command =
  | { op: 'join'; callId: string; convId: string; via: string[]; spacingMs: number }
  | { op: 'stats' }
  | { op: 'stop' };

process.on('message', (cmd: Command) => {
  if (cmd.op === 'join') {
    sims.forEach((s, k) =>
      setTimeout(() => {
        void s.calls
          .join(cmd.callId, cmd.convId, cmd.via, cameras.has(s.index), 15_000)
          .catch((err: unknown) =>
            process.send?.({ type: 'log', text: `join ${s.index}: ${String(err)}` }),
          );
      }, k * cmd.spacingMs),
    );
  } else if (cmd.op === 'stats') {
    process.send?.({
      type: 'stats',
      sims: sims.map((s) => ({
        index: s.index,
        userId: s.userId,
        inCall: s.call !== null,
        host: s.call?.relay?.host ?? null,
        epoch: s.call?.relay?.epoch ?? 0,
        reconnecting: s.call?.relay?.reconnecting ?? null,
        participants: s.call?.participants.length ?? 0,
        bytesIn: s.media?.stats.bytesIn ?? 0,
        lastIn: s.media?.stats.lastIn ?? 0,
        firstIn: s.media?.stats.firstIn ?? 0,
        audio: s.media?.stats.audioConsumers ?? 0,
        video: s.media?.stats.videoConsumers ?? 0,
      })),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  } else if (cmd.op === 'stop') {
    for (const s of sims) {
      s.media?.close();
      s.calls.stop();
    }
    void Promise.all(sims.map((s) => s.links.stop())).then(() => {
      for (const w of workers) w.close();
      process.exit(0);
    });
  }
});

process.send?.({ type: 'ready', userIds: sims.map((s) => s.userId), pid: process.pid });
process.on('disconnect', () => process.exit(0));

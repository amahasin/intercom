/**
 * Many lightweight simulated colleagues in one process. Each has a real identity, sends
 * signed beacons and answers `hello`, `ping` and `profile.get` over its own mutual-TLS
 * link listener, but keeps no database and does not chat. Used to put 200 colleagues in
 * front of the app on one PC.
 */
import {
  createSelfSignedCertificate,
  createTlsTransport,
  encodeBeacon,
  generateIdentityKeyPair,
  LinkManager,
  LOOPBACK_ONLY,
  signProfile,
  silentLogger,
  systemClock,
  UdpDiscoveryDriver,
  userIdFromSpki,
} from '@officemesh/core';
import {
  BEACON_INTERVAL_MS,
  type ManualPresenceState,
  type SignedProfile,
} from '@officemesh/protocol';
import { simName } from './names.ts';

const PRESENCE: ManualPresenceState[] = [
  'available',
  'available',
  'available',
  'busy',
  'away',
  'dnd',
  'brb',
];
const TITLES = ['Accounts', 'Sales', 'Operations', 'HR', 'Engineering', 'Front desk', 'Logistics'];

export interface LiteOptions {
  count: number;
  discoveryPort?: number;
  loopbackOnly?: boolean;
  /** Offset into the sample names so lite peers do not reuse full peers' names. */
  nameOffset?: number;
}

export interface LiteSim {
  userIds: string[];
  stop(): Promise<void>;
}

export async function startLitePeers(options: LiteOptions): Promise<LiteSim> {
  const host = options.loopbackOnly ? '127.0.0.1' : '0.0.0.0';
  const driver = await UdpDiscoveryDriver.open({
    ...(options.discoveryPort !== undefined && { port: options.discoveryPort }),
    logger: silentLogger,
    ...(options.loopbackOnly && { interfaces: LOOPBACK_ONLY }),
  });

  const peers = await Promise.all(
    Array.from({ length: options.count }, async (_, i) => {
      const keys = generateIdentityKeyPair();
      const userId = userIdFromSpki(keys.spki);
      const certPem = await createSelfSignedCertificate(userId, keys.privateKey, keys.publicKey);
      const profile: SignedProfile = signProfile(keys.privateKey, {
        userId,
        version: 1,
        displayName: `${simName(i + (options.nameOffset ?? 0))} ${i + 1}`,
        jobTitle: TITLES[i % TITLES.length]!,
        updatedAt: Date.now(),
      });
      const links = new LinkManager({
        selfId: userId,
        appVersion: 'sim-lite',
        transport: createTlsTransport(
          { privateKey: keys.privateKey, certPem },
          { port: 0, host, logger: silentLogger },
        ),
        clock: systemClock,
        logger: silentLogger,
        caps: ['session.v1', 'profile.v1'],
      });
      links.on('profile.get', (_from, body) =>
        (body as { userId: string }).userId === userId
          ? { type: 'profile.data', body: { profile } }
          : undefined,
      );
      const port = await links.start();
      return { ...keys, userId, port, links, presence: PRESENCE[i % PRESENCE.length]! };
    }),
  );

  // Spread beacons evenly over each 5 s interval, as independent PCs would.
  let next = 0;
  const timer = setInterval(
    () => {
      const p = peers[next++ % peers.length]!;
      driver.send(
        encodeBeacon(p, {
          kind: 'alive',
          port: p.port,
          presence: p.presence,
          profileVer: 1,
          ts: Date.now(),
        }),
      );
    },
    Math.max(1, Math.floor(BEACON_INTERVAL_MS / peers.length)),
  );

  return {
    userIds: peers.map((p) => p.userId),
    stop: async () => {
      clearInterval(timer);
      for (const p of peers) {
        driver.send(
          encodeBeacon(p, {
            kind: 'bye',
            port: p.port,
            presence: p.presence,
            profileVer: 1,
            ts: Date.now(),
          }),
        );
      }
      await Promise.all(peers.map((p) => p.links.stop()));
      await driver.close();
    },
  };
}

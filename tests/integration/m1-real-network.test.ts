/**
 * M1 on the real stack: UDP multicast beacons and mutual-TLS WebSocket links on real
 * time. Pinned to loopback so tests never reach the office LAN.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Core,
  createTlsTransport,
  encodeBeacon,
  generateIdentityKeyPair,
  LOOPBACK_ONLY,
  silentLogger,
  UdpDiscoveryDriver,
  userIdFromSpki,
} from '@officemesh/core';
import { InsecureTestKeyProtector } from '@officemesh/core/testing';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function testPort(): number {
  return 41_000 + Math.floor(Math.random() * 8_000);
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<number> {
  const started = performance.now();
  while (!cond()) {
    if (performance.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return performance.now() - started;
}

async function realPeer(root: string, profile: string, name: string, discoveryPort: number) {
  const core = await Core.start({
    dataDir: join(root, profile),
    profile,
    appVersion: 'test',
    keyProtector: new InsecureTestKeyProtector(),
    logger: silentLogger,
    defaultDisplayName: async () => name,
    network: {
      discovery: await UdpDiscoveryDriver.open({
        port: discoveryPort,
        logger: silentLogger,
        interfaces: LOOPBACK_ONLY,
      }),
      transport: (identity) =>
        createTlsTransport(identity, { port: 0, host: '127.0.0.1', logger: silentLogger }),
    },
  });
  cleanups.push(() => core.close());
  return core;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'officemesh-real-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

describe('M1 on real UDP and TLS', () => {
  it('two peers discover each other within 10 s and a message arrives in under 300 ms', async () => {
    const root = tempRoot();
    const port = testPort();
    const alice = await realPeer(root, 'alice', 'Asha Rahman', port);
    const bob = await realPeer(root, 'bob', 'Bilal Chowdhury', port);
    const named = (c: Core, id: string) =>
      c.people().some((p) => p.userId === id && p.online && p.displayName);
    const took = await waitFor(() => named(alice, bob.userId) && named(bob, alice.userId), 10_000);
    expect(took).toBeLessThan(10_000);

    const conv = alice.openDirect(bob.userId);
    // Warm the link (it is usually already open from the profile fetch).
    await waitFor(() => alice.network!.links.isReady(bob.userId), 5_000);
    let arrivedAt = 0;
    bob.onEvent((name) => {
      if (name === 'messages.added' && !arrivedAt) arrivedAt = performance.now();
    });
    const sentAt = performance.now();
    alice.sendMessage(conv.convId, 'Is the projector free?');
    await waitFor(() => arrivedAt > 0, 2_000);
    expect(arrivedAt - sentAt).toBeLessThan(300);
    await waitFor(() => alice.listMessages(conv.convId)[0]?.status === 'delivered', 2_000);
    expect(bob.listMessages(conv.convId).map((m) => m.text)).toEqual(['Is the projector free?']);
  });

  it('refuses a link to a peer that answers at a known address with the wrong key', async () => {
    const root = tempRoot();
    const port = testPort();
    const alice = await realPeer(root, 'alice', 'Asha Rahman', port);
    const bob = await realPeer(root, 'bob', 'Bilal Chowdhury', port);
    await waitFor(() => alice.people().some((p) => p.userId === bob.userId && p.online), 10_000);
    const bobPort = bob.network!.linkPort!;
    await bob.close();

    // Mallory takes over Bob's address and port.
    const mallory = await Core.start({
      dataDir: join(root, 'mallory'),
      profile: 'mallory',
      appVersion: 'test',
      keyProtector: new InsecureTestKeyProtector(),
      logger: silentLogger,
      defaultDisplayName: async () => 'Bilal Chowdhury',
      network: {
        discovery: await UdpDiscoveryDriver.open({
          port: testPort(),
          logger: silentLogger,
          interfaces: LOOPBACK_ONLY,
        }),
        transport: (identity) =>
          createTlsTransport(identity, { port: bobPort, host: '127.0.0.1', logger: silentLogger }),
      },
    });
    cleanups.push(() => mallory.close());
    expect(mallory.network!.linkPort).toBe(bobPort);
    let malloryLinks = 0;
    mallory.network!.links.onLinkUp(() => malloryLinks++);

    expect(await alice.network!.links.ensureLink(bob.userId, '127.0.0.1', bobPort)).toBe(false);
    expect(malloryLinks).toBe(0);
    expect(alice.network!.links.isReady(bob.userId)).toBe(false);
  });

  it(
    '200 simulated peers: people list stays responsive and beacon handling stays under 2% CPU',
    { timeout: 90_000 },
    async () => {
      const root = tempRoot();
      const port = testPort();
      const target = await realPeer(root, 'target', 'Target', port);

      // 200 colleagues, each beaconing every 5 s, spread evenly (one every 25 ms).
      const colleagues = Array.from({ length: 200 }, () => {
        const keys = generateIdentityKeyPair();
        return { ...keys, userId: userIdFromSpki(keys.spki) };
      });
      const blaster = await UdpDiscoveryDriver.open({
        port,
        logger: silentLogger,
        interfaces: LOOPBACK_ONLY,
      });
      cleanups.push(() => blaster.close());
      let next = 0;
      const timer = setInterval(() => {
        const c = colleagues[next++ % colleagues.length]!;
        // Port 9 (discard) is closed on loopback: profile fetches fail fast and back off.
        blaster.send(
          encodeBeacon(c, {
            kind: 'alive',
            port: 9,
            presence: 'available',
            profileVer: 1,
            ts: Date.now(),
          }),
        );
      }, 25);
      cleanups.push(() => clearInterval(timer));

      await waitFor(() => target.people().filter((p) => p.online).length === 200, 15_000);

      // Steady state: measure 20 s of beacon handling.
      const stats = target.network!.discovery.stats;
      const handlerBefore = stats.handlerMs;
      const acceptedBefore = stats.accepted;
      const cpuBefore = process.cpuUsage();
      const wallBefore = performance.now();
      await new Promise((r) => setTimeout(r, 20_000));
      const wall = performance.now() - wallBefore;
      const cpu = process.cpuUsage(cpuBefore);
      const handlerShare = (stats.handlerMs - handlerBefore) / wall;
      const processShare = (cpu.user + cpu.system) / 1_000 / wall;
      console.info(
        `200 peers: ${stats.accepted - acceptedBefore} beacons in ${Math.round(wall)} ms; ` +
          `beacon handling ${(handlerShare * 100).toFixed(2)}% of one core; whole test process ${(processShare * 100).toFixed(2)}%`,
      );
      expect(handlerShare).toBeLessThan(0.02);

      const t0 = performance.now();
      const people = target.people();
      expect(performance.now() - t0).toBeLessThan(50);
      expect(people.filter((p) => p.online)).toHaveLength(200);
    },
  );
});

describe('M1 quit on the real stack', () => {
  it('a peer that quits shows Offline within 2 s (its bye beacon gets out before the socket closes)', async () => {
    const root = tempRoot();
    const port = testPort();
    const alice = await realPeer(root, 'alice', 'Asha Rahman', port);
    const bob = await realPeer(root, 'bob', 'Bilal Chowdhury', port);
    const bobId = bob.userId;
    await waitFor(() => alice.people().some((p) => p.userId === bobId && p.online), 10_000);
    const quitAt = performance.now();
    await bob.close();
    const took = await waitFor(
      () => alice.people().some((p) => p.userId === bobId && !p.online),
      2_000,
    );
    expect(performance.now() - quitAt).toBeLessThan(2_000);
    expect(took).toBeLessThan(2_000);
  });
});

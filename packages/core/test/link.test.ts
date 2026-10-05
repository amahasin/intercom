import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LINK_PATH } from '@officemesh/protocol';
import {
  createSelfSignedCertificate,
  generateIdentityKeyPair,
  LinkManager,
  MemoryNetwork,
  silentLogger,
  systemClock,
  TlsWsTransport,
  userIdFromSpki,
  type Transport,
} from '../src/index.ts';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function tlsIdentity() {
  const keys = generateIdentityKeyPair();
  const userId = userIdFromSpki(keys.spki);
  const certPem = await createSelfSignedCertificate(userId, keys.privateKey, keys.publicKey);
  const keyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { userId, spki: keys.spki, keyPem, certPem };
}

async function manager(selfId: string, transport: Transport) {
  const lm = new LinkManager({
    selfId,
    appVersion: 'test',
    transport,
    clock: systemClock,
    logger: silentLogger,
  });
  const port = await lm.start();
  stops.push(() => lm.stop());
  return { lm, port };
}

describe('link manager over mutual TLS', () => {
  it('connects, authenticates both ends and answers requests', async () => {
    const a = await tlsIdentity();
    const b = await tlsIdentity();
    const A = await manager(
      a.userId,
      new TlsWsTransport({ ...a, port: 0, host: '127.0.0.1', logger: silentLogger }),
    );
    const B = await manager(
      b.userId,
      new TlsWsTransport({ ...b, port: 0, host: '127.0.0.1', logger: silentLogger }),
    );
    B.lm.on('profile.get', (from, body) => ({
      type: 'profile.data',
      body: { profile: { from, asked: body } },
    }));
    const upOnB = new Promise<string>((r) => B.lm.onLinkUp(r));

    expect(await A.lm.ensureLink(b.userId, '127.0.0.1', B.port)).toBe(true);
    expect(await upOnB).toBe(a.userId);
    const started = performance.now();
    const reply = await A.lm.request(b.userId, 'profile.get', { userId: b.userId });
    expect(performance.now() - started).toBeLessThan(300);
    expect(reply).toEqual({
      type: 'profile.data',
      body: { profile: { from: a.userId, asked: { userId: b.userId } } },
    });
    expect(await A.lm.probe(b.userId, 2_000)).toBe(true);
  });

  it('refuses a peer that presents the wrong key when dialed', async () => {
    const a = await tlsIdentity();
    const bob = await tlsIdentity();
    const mallory = await tlsIdentity();
    const A = await manager(
      a.userId,
      new TlsWsTransport({ ...a, port: 0, host: '127.0.0.1', logger: silentLogger }),
    );
    // Mallory listens where Alice expects Bob.
    const M = await manager(
      mallory.userId,
      new TlsWsTransport({ ...mallory, port: 0, host: '127.0.0.1', logger: silentLogger }),
    );
    let malloryLinked = false;
    M.lm.onLinkUp(() => (malloryLinked = true));
    expect(await A.lm.ensureLink(bob.userId, '127.0.0.1', M.port)).toBe(false);
    expect(A.lm.isReady(bob.userId)).toBe(false);
    expect(malloryLinked).toBe(false);
    void A;
  });

  it('refuses an inbound peer whose hello claims a userId its certificate does not prove', async () => {
    const a = await tlsIdentity();
    const bob = await tlsIdentity();
    const mallory = await tlsIdentity();
    const A = await manager(
      a.userId,
      new TlsWsTransport({ ...a, port: 0, host: '127.0.0.1', logger: silentLogger }),
    );
    let linked = false;
    A.lm.onLinkUp(() => (linked = true));
    // Mallory connects with her own certificate but says she is Bob.
    const ws = new WebSocket(`wss://127.0.0.1:${A.port}${LINK_PATH}`, {
      key: mallory.keyPem,
      cert: mallory.certPem,
      rejectUnauthorized: false,
    });
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          v: 1,
          type: 'hello',
          id: '1',
          body: { protocol: 1, app: 'x', userId: bob.userId, caps: [] },
        }),
      ),
    );
    await closed;
    expect(linked).toBe(false);
    expect(A.lm.readyPeers()).toEqual([]);
  });

  it('refuses a connection without a client certificate', async () => {
    const a = await tlsIdentity();
    const A = await manager(
      a.userId,
      new TlsWsTransport({ ...a, port: 0, host: '127.0.0.1', logger: silentLogger }),
    );
    const ws = new WebSocket(`wss://127.0.0.1:${A.port}${LINK_PATH}`, {
      rejectUnauthorized: false,
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('opened'));
      ws.on('error', () => resolve('error'));
      ws.on('close', () => resolve('closed'));
    });
    expect(outcome).not.toBe('opened');
  });

  it('falls back to a random port when the preferred one is taken', async () => {
    const a = await tlsIdentity();
    const b = await tlsIdentity();
    const A = await manager(
      a.userId,
      new TlsWsTransport({ ...a, port: 0, host: '127.0.0.1', logger: silentLogger }),
    );
    const B = await manager(
      b.userId,
      new TlsWsTransport({ ...b, port: A.port, host: '127.0.0.1', logger: silentLogger }),
    );
    expect(B.port).not.toBe(A.port);
  });
});

describe('link manager over the memory network', () => {
  function ids() {
    const k = generateIdentityKeyPair();
    return { userId: userIdFromSpki(k.spki), spki: k.spki };
  }

  it('keeps exactly one link, dialed by the lower userId, when both dial at once', async () => {
    const net = new MemoryNetwork();
    const a = ids();
    const b = ids();
    const A = await manager(a.userId, net.transport('10.0.0.1', a));
    const B = await manager(b.userId, net.transport('10.0.0.2', b));
    const [okA, okB] = await Promise.all([
      A.lm.ensureLink(b.userId, '10.0.0.2', B.port),
      B.lm.ensureLink(a.userId, '10.0.0.1', A.port),
    ]);
    expect(okA && okB).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(net.openChannels).toBe(2); // one channel = two ends
    expect(A.lm.isReady(b.userId) && B.lm.isReady(a.userId)).toBe(true);
    // The surviving link still carries traffic both ways.
    B.lm.on('profile.get', () => ({ type: 'profile.data', body: { profile: {} } }));
    A.lm.on('profile.get', () => ({ type: 'profile.data', body: { profile: {} } }));
    await expect(
      A.lm.request(b.userId, 'profile.get', { userId: b.userId }),
    ).resolves.toBeDefined();
    await expect(
      B.lm.request(a.userId, 'profile.get', { userId: a.userId }),
    ).resolves.toBeDefined();
  });

  it('reports the link down when the peer says bye, and backs off after failed dials', async () => {
    const net = new MemoryNetwork();
    const a = ids();
    const b = ids();
    const A = await manager(a.userId, net.transport('10.0.0.1', a));
    const B = await manager(b.userId, net.transport('10.0.0.2', b));
    const upOnB = new Promise((r) => B.lm.onLinkUp(r));
    await A.lm.ensureLink(b.userId, '10.0.0.2', B.port);
    await upOnB; // each side is ready once it has the other's hello
    const down = new Promise<string>((r) => A.lm.onLinkDown((_u, reason) => r(reason)));
    B.lm.disconnect(a.userId, 'test');
    expect(await down).toBe('peer said bye');

    const ghost = ids();
    expect(await A.lm.ensureLink(ghost.userId, '10.0.0.9', 47801)).toBe(false);
    expect(A.lm.canDial(ghost.userId)).toBe(false); // inside the 1 s backoff
  });
});

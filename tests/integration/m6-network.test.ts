import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Core, openSealed, silentLogger } from '@officemesh/core';
import { FakeClock, InsecureTestKeyProtector } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { decodeBase64Url, SealedEnvelope } from '@officemesh/protocol';
import { allKnowEachOther, person, run, until } from './helpers.ts';

const sims: InProcessSim[] = [];
const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
  for (const s of sims.splice(0)) await s.stop();
});

async function lan(count: number, subnet?: (i: number) => number) {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count, clock, ...(subnet && { subnet }) });
  sims.push(sim);
  const core = (i: number) => sim.peers[i]!.core;
  return { clock, sim, core };
}

describe('M6 sealed envelopes', () => {
  it('delivers a direct message with the sender offline, through a carrier that cannot read it', async () => {
    const { clock, sim, core } = await lan(3);
    await until(clock, () => allKnowEachOther([core(0), core(1), core(2)]), 20_000);
    const [alice, carol] = [core(0), core(2)];
    const bobId = core(1).userId;
    await sim.stopPeer(1);
    await until(clock, () => person(alice, bobId)?.online === false, 5_000);

    const secret = 'The quarterly figures are in the blue folder';
    const conv = alice.openDirect(bobId);
    const sent = alice.sendMessage(conv.convId, secret);
    expect(sent.status).toBe('waiting');
    // Sealed and left with the one colleague online.
    await until(clock, () => alice.listMessages(conv.convId)[0]?.status === 'carried', 5_000);
    const held = carol.store.db
      .prepare('SELECT to_user AS toUser, from_user AS fromUser, json FROM envelopes')
      .all() as Array<{ toUser: string; fromUser: string; json: string }>;
    expect(held).toHaveLength(1);
    expect(held[0]!.toUser).toBe(bobId);

    // The carrier cannot read it: nothing in its database or on its disk holds the text,
    // and its own key does not open the envelope.
    const env = SealedEnvelope.parse(JSON.parse(held[0]!.json));
    expect(() =>
      openSealed(
        carol.identity.privateKey,
        {
          epk: Buffer.from(decodeBase64Url(env.epk)),
          iv: Buffer.from(decodeBase64Url(env.iv)),
          ct: Buffer.from(decodeBase64Url(env.ct)),
        },
        `${env.v}\0${env.to}\0${env.exp}`,
      ),
    ).toThrow();
    carol.store.db.pragma('wal_checkpoint(TRUNCATE)');
    const carolDir = sim.peers[2]!.dataDir;
    for (const f of readdirSync(carolDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)) {
      const bytes = readFileSync(join(carolDir, f));
      expect(bytes.includes(Buffer.from('quarterly figures')), f).toBe(false);
    }
    expect(JSON.stringify(carol.conversationList())).not.toContain('quarterly');

    // The sender goes offline; Bob comes back and gets it from Carol.
    await sim.stopPeer(0);
    const bob = (await sim.startPeer(1)).core;
    const bobConv = () =>
      bob.conversationList().find((c) => c.kind === 'direct' && c.peerUserId === alice.userId);
    await until(clock, () => bobConv() !== undefined, 20_000);
    const got = bob.listMessages(bobConv()!.convId);
    expect(got.map((m) => m.text)).toEqual([secret]);
    expect(got[0]!.author).toBe(alice.userId);
    // Delivered: the carrier drops its copy.
    await until(
      clock,
      () =>
        (carol.store.db.prepare('SELECT COUNT(*) AS n FROM envelopes').get() as { n: number }).n ===
        0,
      5_000,
    );

    // When Alice returns, she learns it was delivered and forgets her sealed copy.
    const alice2 = (await sim.startPeer(0)).core;
    await until(clock, () => alice2.listMessages(conv.convId)[0]?.status === 'delivered', 30_000);
    expect(
      (alice2.store.db.prepare('SELECT COUNT(*) AS n FROM envelopes_out').get() as { n: number }).n,
    ).toBe(0);
  });

  it('places each envelope with at most 3 carriers and never with the recipient', async () => {
    const { clock, sim, core } = await lan(6);
    await until(clock, () => allKnowEachOther([0, 1, 2, 3, 4, 5].map(core)), 20_000);
    const bobId = core(1).userId;
    await sim.stopPeer(1);
    const alice = core(0);
    await until(clock, () => person(alice, bobId)?.online === false, 5_000);
    const conv = alice.openDirect(bobId);
    for (let i = 0; i < 5; i++) alice.sendMessage(conv.convId, `note ${i}`);
    await until(
      clock,
      () => alice.listMessages(conv.convId).every((m) => m.status === 'carried'),
      5_000,
    );
    await run(clock, 2_000);
    const carriers = [2, 3, 4, 5].map(
      (i) =>
        (core(i).store.db.prepare('SELECT COUNT(*) AS n FROM envelopes').get() as { n: number }).n,
    );
    // Five envelopes, three carriers each.
    expect(carriers.reduce((a, b) => a + b, 0)).toBe(15);
    const placed = alice.store.db
      .prepare('SELECT carriers_json AS c FROM envelopes_out')
      .all() as Array<{ c: string }>;
    for (const row of placed) expect(JSON.parse(row.c)).toHaveLength(3);
  });
});

describe('M6 other subnets', () => {
  it('one typed address reveals the whole other subnet, both ways', async () => {
    // Peers 0-2 on 10.0.x.x, peers 3-5 on 10.1.x.x: beacons stay inside each subnet.
    const { clock, sim, core } = await lan(6, (i) => (i < 3 ? 0 : 1));
    const all = [0, 1, 2, 3, 4, 5].map(core);
    await until(
      clock,
      () => allKnowEachOther(all.slice(0, 3)) && allKnowEachOther(all.slice(3)),
      20_000,
    );
    // Nobody sees across the router yet.
    expect(person(core(0), core(4).userId)).toBeUndefined();

    const answered = await core(0).addPeer(sim.peers[3]!.address);
    expect(answered.userId).toBe(core(3).userId);
    const took = await until(clock, () => allKnowEachOther(all), 30_000);
    expect(took).toBeLessThan(30_000);
    expect(core(0).settings().peerAddresses).toEqual([sim.peers[3]!.address]);
    // (A local colleague linked before its first beacon arrived counts as remote until it does.)
    await until(clock, () => core(1).networkStatus().remoteOnline === 3, 6_000);

    // Presence crosses the router over the link, with no beacons.
    core(4).setPresence('busy');
    await until(clock, () => person(core(1), core(4).userId)?.presence === 'busy', 5_000);

    // A remote colleague who quits shows offline; when it comes back it is found again.
    await sim.stopPeer(5);
    const fiveId = sim.peers[5]?.core.userId ?? all[5]!.userId;
    await until(clock, () => person(core(1), fiveId)?.online === false, 20_000);
    await sim.startPeer(5);
    await until(clock, () => person(core(1), fiveId)?.online === true, 90_000);

    // Chat works across subnets.
    const conv = core(2).openDirect(core(3).userId);
    core(2).sendMessage(conv.convId, 'hello from the other floor');
    await until(clock, () => core(2).listMessages(conv.convId)[0]?.status === 'delivered', 5_000);
  });
});

describe('M6 moving a profile to another PC', () => {
  it('exports the key and history under a passphrase and imports them elsewhere', async () => {
    const { clock, core } = await lan(2);
    await until(clock, () => allKnowEachOther([core(0), core(1)]), 20_000);
    const alice = core(0);
    const conv = alice.openDirect(core(1).userId);
    alice.sendMessage(conv.convId, 'before the move');
    await until(clock, () => alice.listMessages(conv.convId)[0]?.status === 'delivered', 5_000);

    const downloads = mkdtempSync(join(tmpdir(), 'officemesh-dl-'));
    (alice as unknown as { options: { downloadsDir: string } }).options.downloadsDir = downloads;
    const { path } = await alice.exportProfile('correct horse battery');
    const file = readFileSync(path);
    expect(file.subarray(0, 20).toString()).toBe('OFFICEMESH-PROFILE-1');
    expect(file.includes(Buffer.from('before the move'))).toBe(false);

    // A new PC: its own fresh profile first.
    const root = mkdtempSync(join(tmpdir(), 'officemesh-newpc-'));
    const open = () =>
      Core.start({
        dataDir: join(root, 'default'),
        filesDir: join(root, 'files'),
        profile: 'default',
        appVersion: 'test',
        keyProtector: new InsecureTestKeyProtector(),
        logger: silentLogger,
        clock,
        defaultDisplayName: async () => 'New PC user',
      });
    const fresh = await open();
    expect(fresh.userId).not.toBe(alice.userId);
    await expect(fresh.importProfile(path, 'wrong passphrase')).rejects.toThrow(/passphrase/);
    const who = await fresh.importProfile(path, 'correct horse battery');
    expect(who.userId).toBe(alice.userId);
    // Nothing changes until restart.
    expect(fresh.userId).not.toBe(alice.userId);
    await fresh.close();

    const moved = await open();
    cores.push(moved);
    expect(moved.userId).toBe(alice.userId);
    expect(moved.identityView().displayName).toBe(alice.identityView().displayName);
    expect(moved.listMessages(conv.convId).map((m) => m.text)).toEqual(['before the move']);
    // The replaced profile is kept.
    expect(readdirSync(root).some((n) => n.startsWith('default.before-import-'))).toBe(true);
  });
});

describe('M6 updates from a shared folder', () => {
  it('finds the newest installer for this architecture and checks its publisher', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'officemesh-updates-'));
    for (const name of [
      'OfficeMesh-Setup-0.5.9-x64.exe',
      'OfficeMesh-Setup-0.6.2-x64.exe',
      'OfficeMesh-Setup-0.7.0-arm64.exe',
      'OfficeMesh-Setup-0.6.10-x64.exe',
      'notes.txt',
    ])
      writeFileSync(join(folder, name), 'x');
    mkdirSync(join(folder, 'OfficeMesh-Setup-9.9.9-x64.exe'));
    const root = mkdtempSync(join(tmpdir(), 'officemesh-upd-'));
    const signatures: Record<
      string,
      { status: 'valid' | 'unsigned' | 'invalid'; publisher?: string }
    > = {};
    let own: { status: 'valid' | 'unsigned' | 'invalid'; publisher?: string } = {
      status: 'unsigned',
    };
    const installed: string[] = [];
    const core = await Core.start({
      dataDir: join(root, 'p'),
      filesDir: join(root, 'files'),
      profile: 'p',
      appVersion: '0.6.0',
      arch: 'x64',
      keyProtector: new InsecureTestKeyProtector(),
      logger: silentLogger,
      defaultDisplayName: async () => 'Updater',
      host: {
        fixFirewall: async () => {},
        openNetworkSettings: () => {},
        verifySignature: async (p) =>
          p === null ? own : (signatures[p] ?? { status: 'unsigned' }),
        runInstaller: (p) => installed.push(p),
      },
    });
    cores.push(core);
    expect((await core.checkForUpdate()).state).toBe('off');
    core.setSettings({ updateFolder: folder });
    const found = await core.checkForUpdate();
    expect(found).toMatchObject({ state: 'available', version: '0.6.10', signature: 'unsigned' });
    core.installUpdate();
    expect(installed).toEqual([join(folder, 'OfficeMesh-Setup-0.6.10-x64.exe')]);

    // A signed build accepts only its own publisher's installer.
    own = { status: 'valid', publisher: 'CN=Example Office' };
    signatures[join(folder, 'OfficeMesh-Setup-0.6.10-x64.exe')] = {
      status: 'valid',
      publisher: 'CN=Someone Else',
    };
    expect(await core.checkForUpdate()).toMatchObject({ state: 'error', signature: 'invalid' });
    expect(() => core.installUpdate()).toThrow();
    signatures[join(folder, 'OfficeMesh-Setup-0.6.10-x64.exe')] = {
      status: 'valid',
      publisher: 'CN=Example Office',
    };
    expect(await core.checkForUpdate()).toMatchObject({ state: 'available', signature: 'valid' });

    // An unreadable folder is reported, not thrown.
    core.setSettings({ updateFolder: join(folder, 'missing') });
    expect((await core.checkForUpdate()).state).toBe('error');
  });
});

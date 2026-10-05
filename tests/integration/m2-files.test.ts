import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '@officemesh/core';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import type { FileStatus } from '@officemesh/protocol/ipc';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitFor(cond: () => boolean, timeoutMs: number, what = 'condition'): Promise<void> {
  const start = Date.now();
  const holds = () => {
    try {
      return cond();
    } catch {
      return false; // e.g. the conversation has not reached this peer yet
    }
  };
  while (!holds()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Two (or three) PCs on a simulated LAN, on real time (disk I/O does not suit a fake clock). */
async function lan(count = 2): Promise<{ sim: InProcessSim; core: (i: number) => Core }> {
  const sim = await startInProcessPeers({ count });
  cleanups.push(() => sim.stop());
  const core = (i: number) => sim.peers[i]!.core;
  await waitFor(
    () =>
      sim.peers.every((a) =>
        sim.peers.every(
          (b) =>
            a === b ||
            a.core.people().some((p) => p.userId === b.core.userId && p.online && p.displayName),
        ),
      ),
    15_000,
    'discovery',
  );
  return { sim, core };
}

/** A file of `mb` megabytes with distinct content per megabyte (cheap to generate). */
async function makeFile(mb: number): Promise<{ path: string; sha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'officemesh-files-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `payload-${mb}mb.bin`);
  const block = randomBytes(1024 * 1024);
  const hash = createHash('sha256');
  const fh = await open(path, 'w');
  for (let i = 0; i < mb; i++) {
    block.writeUInt32BE(i, 0);
    hash.update(block);
    await fh.write(block);
  }
  await fh.close();
  return { path, sha: hash.digest('hex') };
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const piece of createReadStream(path)) hash.update(piece as Buffer);
  return hash.digest('hex');
}

function watchProgress(core: Core): FileStatus[] {
  const seen: FileStatus[] = [];
  core.onEvent((name, payload) => name === 'files.progress' && seen.push(payload as FileStatus));
  return seen;
}

describe('M2 file transfer', () => {
  it(
    'transfers a 1 GB file, resumes after the cable is pulled mid-way, and verifies its hash',
    { timeout: 300_000 },
    async () => {
      const { sim, core } = await lan();
      const [alice, bob] = [core(0), core(1)];
      const conv = alice.openDirect(bob.userId).convId;
      const { path, sha } = await makeFile(1024);
      const shared = await alice.shareFile({ convId: conv, path });
      expect(shared.file).toMatchObject({ sha256: sha, size: 1024 * 1024 * 1024 });
      await waitFor(
        () => bob.listMessages(conv).some((m) => m.file?.sha256 === sha),
        5_000,
        'file message',
      );

      const progress = watchProgress(bob);
      const started = Date.now();
      bob.downloadFile(sha);
      await waitFor(
        () => bob.fileStatus(sha).received > 300 * 1024 * 1024,
        120_000,
        '30% received',
      );

      // Pull Alice's cable: links drop, nothing gets through for 3 seconds.
      sim.unplug(0);
      sim.net.pullPlug(sim.peers[0]!.address);
      const atPull = bob.fileStatus(sha).received;
      await new Promise((r) => setTimeout(r, 3_000));
      expect(bob.fileStatus(sha).state).not.toBe('complete');
      sim.replug(0);

      await waitFor(() => bob.fileStatus(sha).state === 'complete', 180_000, 'completion');
      const seconds = (Date.now() - started) / 1000;
      // Resumed, not restarted: progress after the pull never went back below where it was.
      const afterPull = progress
        .filter((p) => p.state === 'downloading' && p.received > 0)
        .map((p) => p.received);
      const firstAfterResume = afterPull.find((r, i) => i > 0 && r < afterPull[i - 1]!);
      expect(firstAfterResume).toBeUndefined();
      expect(atPull).toBeGreaterThan(0);
      expect(await sha256Of(bob.files.path(sha))).toBe(sha);
      console.info(
        `1 GB transferred in ${seconds.toFixed(1)} s including a 3 s cable pull at ${(atPull / 2 ** 20).toFixed(0)} MB`,
      );
    },
  );

  it('detects a corrupted chunk and fetches it again', { timeout: 60_000 }, async () => {
    const { core } = await lan();
    const [alice, bob] = [core(0), core(1)];
    const conv = alice.openDirect(bob.userId).convId;
    const { path, sha } = await makeFile(6);
    await alice.shareFile({ convId: conv, path });
    await waitFor(
      () => bob.listMessages(conv).some((m) => m.file?.sha256 === sha),
      5_000,
      'file message',
    );

    // Alice's disk returns one bad chunk once (a flipped bit).
    const store = alice.files;
    const original = store.readChunk.bind(store);
    let corrupted = 0;
    store.readChunk = async (s: string, index: number) => {
      const data = await original(s, index);
      if (data && index === 3 && corrupted === 0) {
        corrupted++;
        data[1234] = data[1234]! ^ 0x01;
      }
      return data;
    };
    bob.downloadFile(sha);
    await waitFor(() => bob.fileStatus(sha).state === 'complete', 30_000, 'completion');
    expect(corrupted).toBe(1);
    expect(await sha256Of(bob.files.path(sha))).toBe(sha);
  });

  it('resumes a download after the receiver restarts', { timeout: 120_000 }, async () => {
    const { sim, core } = await lan();
    const conv = core(0).openDirect(core(1).userId).convId;
    const { path, sha } = await makeFile(60);
    await core(0).shareFile({ convId: conv, path });
    await waitFor(
      () =>
        core(1)
          .listMessages(conv)
          .some((m) => m.file?.sha256 === sha),
      5_000,
      'file message',
    );

    // Record which chunks Alice serves.
    let served = new Set<number>();
    const store = core(0).files;
    const original = store.readChunk.bind(store);
    store.readChunk = async (s: string, i: number) => {
      served.add(i);
      return original(s, i);
    };
    core(1).downloadFile(sha);
    await waitFor(
      () => core(1).fileStatus(sha).received >= 20 * 1024 * 1024,
      30_000,
      'a third received',
    );
    await sim.stopPeer(1);
    await sim.startPeer(1);
    const missingAtRestart = new Set(core(1).files.missingChunks(sha));
    served = new Set();
    await waitFor(
      () =>
        core(1)
          .people()
          .some((p) => p.userId === core(0).userId && p.online),
      15_000,
      'rediscovery',
    );
    core(1).downloadFile(sha);
    await waitFor(() => core(1).fileStatus(sha).state === 'complete', 60_000, 'completion');
    expect(await sha256Of(core(1).files.path(sha))).toBe(sha);
    // The chunk bitmap survived the restart, and nothing already held was fetched again.
    expect(missingAtRestart.size).toBeLessThan(60);
    expect([...served].filter((i) => !missingAtRestart.has(i))).toEqual([]);
  });

  it(
    'auto-downloads small images, reports a file as unavailable while no holder is online, and marks downloads as from another computer',
    { timeout: 60_000 },
    async () => {
      const { sim, core } = await lan();
      const [alice, bob] = [core(0), core(1)];
      const conv = alice.openDirect(bob.userId).convId;
      // A pasted 1 MB "image" downloads by itself.
      const image = randomBytes(1024 * 1024);
      const shot = await alice.shareFile({
        convId: conv,
        data: image,
        name: 'screenshot.png',
        mime: 'image/png',
      });
      const imageSha = shot.file!.sha256;
      await waitFor(
        () => bob.fileStatus(imageSha).state === 'complete',
        15_000,
        'image auto-download',
      );
      expect(readFileSync(bob.files.path(imageSha)).equals(image)).toBe(true);
      if (process.platform === 'win32') {
        await waitFor(
          () => existsSync(`${bob.files.path(imageSha)}:Zone.Identifier`),
          2_000,
          'zone identifier',
        );
        expect(readFileSync(`${bob.files.path(imageSha)}:Zone.Identifier`, 'utf8')).toContain(
          'ZoneId=3',
        );
      }

      // A document is not fetched until asked; with Alice gone it is unavailable.
      const { path, sha } = await makeFile(3);
      await alice.shareFile({ convId: conv, path, text: 'Minutes attached' });
      await waitFor(
        () => bob.listMessages(conv).some((m) => m.file?.sha256 === sha),
        5_000,
        'file message',
      );
      expect(bob.fileStatus(sha).state).toBe('missing');
      expect(bob.listMessages(conv).find((m) => m.file?.sha256 === sha)?.text).toBe(
        'Minutes attached',
      );
      await sim.stopPeer(0);
      await waitFor(
        () => bob.people().some((p) => p.userId === alice.userId && !p.online),
        5_000,
        'Alice offline',
      );
      bob.downloadFile(sha);
      await waitFor(() => bob.fileStatus(sha).state === 'unavailable', 10_000, 'unavailable');
      await sim.startPeer(0);
      await waitFor(
        () => bob.fileStatus(sha).state === 'complete',
        30_000,
        'download once Alice is back',
      );
    },
  );
});

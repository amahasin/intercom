import { randomBytes } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if (cond()) return;
    } catch {
      // not there yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function makeFile(mb: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'officemesh-speed-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `payload-${mb}mb.bin`);
  const block = randomBytes(1024 * 1024);
  const fh = await open(path, 'w');
  for (let i = 0; i < mb; i++) await fh.write(block);
  await fh.close();
  return path;
}

describe('M6.10 file transfer speed', () => {
  it(
    'moves a big file between two PCs as fast as the machine allows',
    {
      timeout: 300_000,
    },
    async () => {
      const sim: InProcessSim = await startInProcessPeers({ count: 2 });
      cleanups.push(() => sim.stop());
      const [alice, bob] = sim.peers.map((p) => p.core) as [
        (typeof sim.peers)[0]['core'],
        (typeof sim.peers)[0]['core'],
      ];
      await waitFor(
        () => alice.people().some((p) => p.userId === bob.userId && p.online && p.displayName),
        15_000,
        'discovery',
      );
      const conv = alice.openDirect(bob.userId).convId;
      const mb = Number(process.env['SPEED_MB'] ?? 768);
      const path = await makeFile(mb);
      const sha = (await alice.shareFile({ convId: conv, path })).file!.sha256;
      await waitFor(
        () => bob.listMessages(conv).some((m) => m.file?.sha256 === sha),
        5_000,
        'card',
      );
      // Wait out the automatic receive that a fresh file starts, so only the transfer is timed.
      const started = Date.now();
      bob.downloadFile(sha);
      const timeline = setInterval(() => {
        const st = bob.fileStatus(sha);
        console.info(
          `t=${((Date.now() - started) / 1000).toFixed(1)}s ${st.state} ${(st.received / 2 ** 20).toFixed(0)} MB`,
        );
      }, 2_000);
      await waitFor(() => bob.fileStatus(sha).state === 'complete', 240_000, 'download');
      clearInterval(timeline);
      const seconds = (Date.now() - started) / 1000;
      const rate = mb / seconds;
      console.info(`${mb} MB in ${seconds.toFixed(2)} s: ${rate.toFixed(0)} MB/s`);
      // A floor far below a gigabit link (about 110 MB/s): a slow disk or CPU may fail it, a
      // transfer that waits on something per chunk will.
      expect(rate).toBeGreaterThan(60);
    },
  );
});

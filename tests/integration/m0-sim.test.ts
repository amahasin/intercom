import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserId } from '@officemesh/protocol';
import { FakeClock } from '@officemesh/core/testing';
import { simName, startInProcessPeers, startProcessPeers } from '@officemesh/sim';

describe('tools/sim', () => {
  it('starts headless core peers as bare Node processes, each with its own identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'officemesh-it-'));
    try {
      const first = await startProcessPeers({ count: 5, dataRoot: root });
      const ids = first.peers.map((p) => p.identity.userId);
      expect(new Set(ids).size).toBe(5);
      for (const id of ids) expect(UserId.safeParse(id).success).toBe(true);
      expect(first.peers.map((p) => p.identity.displayName)).toEqual([0, 1, 2, 3, 4].map(simName));
      expect(new Set(first.peers.map((p) => p.pid)).size).toBe(5);
      await first.stop();

      // Same data folders, same identities.
      const second = await startProcessPeers({ count: 5, dataRoot: root });
      expect(second.peers.map((p) => p.identity.userId)).toEqual(ids);
      await second.stop();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('starts many in-process peers on a shared loopback segment with a fake clock', async () => {
    const clock = new FakeClock();
    const sim = await startInProcessPeers({ count: 20, clock });
    try {
      expect(new Set(sim.peers.map((p) => p.core.userId)).size).toBe(20);
      expect(sim.peers.every((p) => p.core.identityView().createdAt === clock.now())).toBe(true);
      expect(sim.hub).toBeDefined();
    } finally {
      await sim.stop();
    }
  });
});

/**
 * M6.26: a colleague's page shows the graphics card next to the processor and the memory. The host
 * reads the names of the display adapters from Windows (`graphics`); the core picks the real ones
 * and tells colleagues in the handshake, as the rest of the PC's facts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core, silentLogger } from '@officemesh/core';
import { InsecureTestKeyProtector } from '@officemesh/core/testing';
import { MachineInfo } from '@officemesh/protocol';
import { describeGraphics } from '../../packages/core/src/peers/machine.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('M6.26 which graphics cards are shown', () => {
  it('names the real cards once, and not a remote or virtual display', () => {
    expect(describeGraphics(['NVIDIA GeForce RTX 3060'])).toBe('NVIDIA GeForce RTX 3060');
    // A laptop: the integrated and the discrete card.
    expect(describeGraphics(['Intel(R) UHD Graphics', 'NVIDIA GeForce GTX 1650'])).toBe(
      'Intel(R) UHD Graphics + NVIDIA GeForce GTX 1650',
    );
    // The same card twice (two outputs), spaces tidied.
    expect(describeGraphics(['AMD  Radeon(TM) Graphics', 'AMD Radeon(TM) Graphics'])).toBe(
      'AMD Radeon(TM) Graphics',
    );
    // Virtual adapters are not cards.
    expect(
      describeGraphics(['Microsoft Remote Display Adapter', 'Intel(R) Iris(R) Xe Graphics']),
    ).toBe('Intel(R) Iris(R) Xe Graphics');
    expect(describeGraphics(['Parsec Virtual Display Adapter', 'NVIDIA RTX A2000'])).toBe(
      'NVIDIA RTX A2000',
    );
    // Only a fallback adapter: that is what there is.
    expect(describeGraphics(['Microsoft Basic Display Adapter'])).toBe(
      'Microsoft Basic Display Adapter',
    );
    // Nothing to show.
    expect(describeGraphics([])).toBeUndefined();
    expect(describeGraphics(['', '  '])).toBeUndefined();
  });

  it('is short enough for the handshake, and older colleagues without it still parse', () => {
    const long = describeGraphics(['A'.repeat(200)])!;
    expect(long.length).toBeLessThanOrEqual(120);
    expect(
      MachineInfo.safeParse({ host: 'pc', os: 'Windows', arch: 'x64', gpu: long }).success,
    ).toBe(true);
    // A build from before this one sends no `gpu`.
    expect(MachineInfo.safeParse({ host: 'pc', os: 'Windows', arch: 'x64' }).success).toBe(true);
  });
});

describe('M6.26 the core tells its graphics card', () => {
  async function start(graphics?: () => Promise<string[]>): Promise<Core> {
    const root = mkdtempSync(join(tmpdir(), 'intercom-gpu-'));
    const c = await Core.start({
      dataDir: join(root, 'alice'),
      profile: 'alice',
      appVersion: '0.18.4',
      keyProtector: new InsecureTestKeyProtector(),
      logger: silentLogger,
      defaultDisplayName: async () => 'Alice',
      host: {
        fixFirewall: async () => {},
        openNetworkSettings: () => {},
        ...(graphics && { graphics }),
      },
    });
    cleanups.push(async () => {
      await c.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });
    return c;
  }

  it('adds it to this PC once the host has read it, and says so', async () => {
    const c = await start(async () => ['Intel(R) UHD Graphics', 'NVIDIA GeForce GTX 1650']);
    await vi.waitFor(
      () =>
        expect(c.appInfo().machine?.gpu).toBe('Intel(R) UHD Graphics + NVIDIA GeForce GTX 1650'),
      { timeout: 3_000 },
    );
  });

  it('shows nothing, and carries on, when the host cannot tell', async () => {
    const c = await start(async () => {
      throw new Error('no inventory');
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(c.appInfo().machine?.gpu).toBeUndefined();
    expect(c.appInfo().machine?.cpu).toBeDefined();
  });
});

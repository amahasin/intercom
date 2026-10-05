import { afterEach, describe, expect, it } from 'vitest';
import { createIpcClient, type IpcFrame } from '@officemesh/protocol/ipc';
import { Core, CoreHost, silentLogger, type FramePort } from '../src/index.ts';
import { FakeClock, InsecureTestKeyProtector, makeTempDir } from '../src/testing/index.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A MessageChannel-like pipe: what the UI side sends arrives at the core side and back. */
function pipe() {
  const toCore = new Set<(d: unknown) => void>();
  const toUi = new Set<(d: unknown) => void>();
  // structuredClone mimics the copy a real MessagePort makes.
  const corePort: FramePort = {
    post: (frame) => queueMicrotask(() => toUi.forEach((l) => l(structuredClone(frame)))),
    onMessage: (l) => (toCore.add(l), () => toCore.delete(l)),
  };
  const client = createIpcClient({
    send: (frame: IpcFrame) =>
      queueMicrotask(() => toCore.forEach((l) => l(structuredClone(frame)))),
    onFrame: (l) => (toUi.add(l), () => toUi.delete(l)),
  });
  return { corePort, client };
}

function startCore(dataDir: string) {
  return Core.start({
    dataDir,
    profile: 'test',
    appVersion: '0.0.0-test',
    keyProtector: new InsecureTestKeyProtector(),
    clock: new FakeClock(),
    logger: silentLogger,
    defaultDisplayName: async () => 'Bob Das',
  });
}

describe('CoreHost over a port', () => {
  it('serves typed commands and pushes events', async () => {
    const dir = makeTempDir();
    cleanups.push(dir.dispose);
    const host = new CoreHost(() => startCore(dir.path), silentLogger);
    cleanups.push(() => host.close());
    const { corePort, client } = pipe();
    host.attach(corePort);

    const statuses: string[] = [];
    client.on('core.status', (s) => statuses.push(s.state));

    const identity = await client.invoke('identity.get', {});
    expect(identity.displayName).toBe('Bob Das');

    const info = await client.invoke('app.info', {});
    expect(info).toMatchObject({
      profile: 'test',
      keyProtection: 'insecure-test',
      protocolVersion: 1,
    });

    const changed = new Promise((resolve) => client.on('identity.changed', resolve));
    const updated = await client.invoke('profile.update', { statusMessage: 'In the Dhaka office' });
    expect(updated.statusMessage).toBe('In the Dhaka office');
    await expect(changed).resolves.toEqual(updated);
    expect(statuses).toContain('ready');
  });

  it('answers requests sent before start-up finished', async () => {
    const dir = makeTempDir();
    cleanups.push(dir.dispose);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const host = new CoreHost(async () => {
      await gate;
      return startCore(dir.path);
    }, silentLogger);
    cleanups.push(() => host.close());
    const { corePort, client } = pipe();
    host.attach(corePort);
    const pending = client.invoke('identity.get', {});
    release();
    await expect(pending).resolves.toMatchObject({ displayName: 'Bob Das' });
  });

  it('rejects bad input, unknown commands, and reports start-up failure', async () => {
    const dir = makeTempDir();
    cleanups.push(dir.dispose);
    const host = new CoreHost(() => startCore(dir.path), silentLogger);
    cleanups.push(() => host.close());
    const { corePort, client } = pipe();
    host.attach(corePort);

    await expect(client.invoke('profile.update', { displayName: '' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(client.invoke('app.info', { extra: 1 } as never)).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(client.invoke('no.such' as never, {} as never)).rejects.toMatchObject({
      code: 'unknown_command',
    });

    const failing = new CoreHost(async () => {
      throw new Error('disk full');
    }, silentLogger);
    const p2 = pipe();
    failing.attach(p2.corePort);
    await expect(p2.client.invoke('identity.get', {})).rejects.toMatchObject({
      code: 'not_ready',
      message: 'disk full',
    });
    expect(failing.getStatus()).toEqual({ state: 'error', message: 'disk full' });
  });
});

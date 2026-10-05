import { describe, expect, it } from 'vitest';
import { createIpcClient, IpcCallError, type IpcFrame, type IpcTransport } from '../src/ipc.ts';

function fakeTransport() {
  const sent: IpcFrame[] = [];
  let listener: ((frame: unknown) => void) | undefined;
  const transport: IpcTransport = {
    send: (frame) => sent.push(frame),
    onFrame: (l) => {
      listener = l;
      return () => (listener = undefined);
    },
  };
  return { transport, sent, deliver: (frame: unknown) => listener?.(frame) };
}

const identity = {
  userId: 'abcdefghijklmnopqrstuvwxyz234567',
  publicKey: 'A'.repeat(122),
  displayName: 'Asha',
  profileVersion: 1,
  safetyPhrase: ['a', 'b', 'c', 'd', 'e', 'f'],
  createdAt: 1,
};

describe('ipc client', () => {
  it('resolves a command with the validated result', async () => {
    const t = fakeTransport();
    const client = createIpcClient(t.transport);
    const p = client.invoke('identity.get', {});
    expect(t.sent[0]).toMatchObject({ kind: 'req', name: 'identity.get' });
    t.deliver({
      kind: 'res',
      id: t.sent[0]!.kind === 'req' ? t.sent[0]!.id : -1,
      ok: true,
      result: identity,
    });
    await expect(p).resolves.toEqual(identity);
  });

  it('rejects a result that does not match the output schema', async () => {
    const t = fakeTransport();
    const client = createIpcClient(t.transport);
    const p = client.invoke('identity.get', {});
    t.deliver({ kind: 'res', id: 1, ok: true, result: { userId: 'nope' } });
    await expect(p).rejects.toBeInstanceOf(IpcCallError);
  });

  it('surfaces core errors with their code', async () => {
    const t = fakeTransport();
    const client = createIpcClient(t.transport);
    const p = client.invoke('app.info', {});
    t.deliver({ kind: 'res', id: 1, ok: false, error: { code: 'not_ready', message: 'starting' } });
    await expect(p).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('delivers valid events and drops malformed ones', () => {
    const t = fakeTransport();
    const client = createIpcClient(t.transport);
    const seen: string[] = [];
    client.on('core.status', (s) => seen.push(s.state));
    t.deliver({ kind: 'evt', name: 'core.status', payload: { state: 'ready' } });
    t.deliver({ kind: 'evt', name: 'core.status', payload: { state: 'exploded' } });
    t.deliver({ kind: 'evt', name: 'not.an.event', payload: {} });
    t.deliver('garbage');
    expect(seen).toEqual(['ready']);
  });
});

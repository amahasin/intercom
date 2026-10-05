import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SignedProfile } from '@officemesh/protocol';
import {
  Core,
  DATABASE_FILE_NAME,
  exportPrivateKeyPkcs8,
  KEY_FILE_NAME,
  silentLogger,
  verifyProfile,
  type KeyProtector,
} from '../src/index.ts';
import { FakeClock, InsecureTestKeyProtector, makeTempDir } from '../src/testing/index.ts';

const dirs: Array<{ dispose: () => void }> = [];
const cores: Core[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.close()));
  dirs.splice(0).forEach((d) => d.dispose());
});

/** Simulates safeStorage: output differs from input and only this protector can reverse it. */
class XorProtector implements KeyProtector {
  readonly scheme = 'safeStorage' as const;
  unprotectCalls = 0;
  async protect(plain: Uint8Array) {
    return Uint8Array.from(plain, (b) => b ^ 0x5a);
  }
  async unprotect(sealed: Uint8Array) {
    this.unprotectCalls++;
    return Uint8Array.from(sealed, (b) => b ^ 0x5a);
  }
}

async function start(
  dataDir: string,
  keyProtector: KeyProtector = new InsecureTestKeyProtector(),
  name = 'Asha Rahman',
) {
  const core = await Core.start({
    dataDir,
    profile: 'test',
    appVersion: '0.0.0-test',
    keyProtector,
    clock: new FakeClock(),
    logger: silentLogger,
    defaultDisplayName: async () => name,
  });
  cores.push(core);
  return core;
}

function tempDir(): string {
  const d = makeTempDir();
  dirs.push(d);
  return d.path;
}

describe('identity', () => {
  it('generates an identity on first run with the default display name', async () => {
    const core = await start(tempDir());
    const view = core.identityView();
    expect(view.displayName).toBe('Asha Rahman');
    expect(view.profileVersion).toBe(1);
    expect(view.safetyPhrase).toHaveLength(6);
    expect(
      verifyProfile(core.identity.profile, core.userId, core.identity.publicKey),
    ).toBeDefined();
  });

  it('keeps the same userId across restarts and does not regenerate', async () => {
    const dir = tempDir();
    const first = await start(dir);
    const id = first.userId;
    await first.close();
    const second = await start(dir, undefined, 'Someone Else');
    expect(second.userId).toBe(id);
    expect(second.identityView().displayName).toBe('Asha Rahman');
  });

  it('never writes the plaintext private key to disk', async () => {
    const dir = tempDir();
    const protector = new XorProtector();
    const core = await start(dir, protector);
    const pkcs8 = exportPrivateKeyPkcs8(core.identity.privateKey);
    const keyFile = readFileSync(join(dir, KEY_FILE_NAME), 'utf8');
    expect(keyFile).not.toContain(pkcs8.toString('base64'));
    expect(keyFile).not.toContain(pkcs8.toString('base64url'));
    expect(keyFile).not.toMatch(/PRIVATE KEY/);
    const db = readFileSync(join(dir, DATABASE_FILE_NAME));
    expect(db.includes(pkcs8)).toBe(false);
    expect(JSON.parse(keyFile).scheme).toBe('safeStorage');
  });

  it('unseals the key through the protector on restart', async () => {
    const dir = tempDir();
    const protector = new XorProtector();
    const userId = (await start(dir, protector)).userId;
    await cores.pop()!.close();
    const again = await start(dir, protector);
    expect(again.userId).toBe(userId);
    expect(protector.unprotectCalls).toBe(1);
  });

  it('refuses to load a key sealed by a different scheme', async () => {
    const dir = tempDir();
    await (await start(dir, new InsecureTestKeyProtector())).close();
    cores.pop();
    await expect(start(dir, new XorProtector())).rejects.toThrow(/sealed with insecure-test/);
  });

  it('refuses to silently replace an identity whose key file is gone', async () => {
    const dir = tempDir();
    await (await start(dir)).close();
    cores.pop();
    rmSync(join(dir, KEY_FILE_NAME));
    await expect(start(dir)).rejects.toThrow(/key file is missing/);
  });

  it('refuses a key file that belongs to another identity', async () => {
    const a = tempDir();
    const b = tempDir();
    await (await start(a)).close();
    await (await start(b)).close();
    cores.splice(0);
    writeFileSync(join(a, KEY_FILE_NAME), readFileSync(join(b, KEY_FILE_NAME)));
    await expect(start(a)).rejects.toThrow(/does not match/);
  });

  it('recovers the identity from the key file when the database is lost', async () => {
    const dir = tempDir();
    const userId = (await start(dir)).userId;
    await cores.pop()!.close();
    for (const f of [
      DATABASE_FILE_NAME,
      `${DATABASE_FILE_NAME}-wal`,
      `${DATABASE_FILE_NAME}-shm`,
    ]) {
      rmSync(join(dir, f), { force: true });
    }
    expect((await start(dir)).userId).toBe(userId);
  });
});

describe('profile edits', () => {
  it('bumps the version, re-signs, persists and emits an event', async () => {
    const dir = tempDir();
    const core = await start(dir);
    const events: unknown[] = [];
    core.onEvent((name, payload) => events.push({ name, payload }));
    const view = core.updateProfile({ displayName: 'Asha R.', jobTitle: 'Accounts' });
    expect(view).toMatchObject({ displayName: 'Asha R.', jobTitle: 'Accounts', profileVersion: 2 });
    expect(events).toEqual([{ name: 'identity.changed', payload: view }]);
    expect(
      verifyProfile(core.identity.profile, core.userId, core.identity.publicKey),
    ).toBeDefined();

    core.updateProfile({ jobTitle: '' });
    expect(core.identityView().jobTitle).toBeUndefined();

    await cores.pop()!.close();
    const reopened = await start(dir);
    expect(SignedProfile.parse(reopened.identity.profile)).toMatchObject({
      displayName: 'Asha R.',
      version: 3,
    });
  });
});

/**
 * M6.27: the day someone joined the company is part of their signed profile and reaches colleagues;
 * and "Remote Desktop Connection" on a colleague's page: the sign-in saved for it is sealed, never
 * read back, and handed to the host (Windows) only when connecting.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Core, silentLogger, type KeyProtector, type RemoteDesktopHost } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { isCalendarDay, ProfileEdit } from '@officemesh/protocol';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { joinedDate, tenure } from '../../apps/desktop/renderer/src/people/tenure.ts';
import { allKnowEachOther, run, until } from './helpers.ts';

const sims: InProcessSim[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('M6.27 the day someone joined the company', () => {
  it('only a real calendar day counts', () => {
    expect(isCalendarDay('2021-03-04')).toBe(true);
    expect(isCalendarDay('2024-02-29')).toBe(true);
    expect(isCalendarDay('2023-02-29')).toBe(false);
    expect(isCalendarDay('2021-13-01')).toBe(false);
    expect(isCalendarDay('1949-12-31')).toBe(false);
    expect(isCalendarDay('04/03/2021')).toBe(false);
    expect(isCalendarDay('')).toBe(false);
    expect(isCalendarDay(undefined)).toBe(false);
    expect(ProfileEdit.safeParse({ joinedOn: '2021-03-04' }).success).toBe(true);
    expect(ProfileEdit.safeParse({ joinedOn: '' }).success).toBe(true);
    expect(ProfileEdit.safeParse({ joinedOn: '2021-02-30' }).success).toBe(false);
    expect(ProfileEdit.safeParse({ joinedOn: 'yesterday' }).success).toBe(false);
  });

  it('is told to colleagues with the rest of the profile, changed, and cleared', async () => {
    const clock = new FakeClock();
    const sim = await startInProcessPeers({ count: 2, clock });
    sims.push(sim);
    const [a, b] = [0, 1].map((i) => sim.peers[i]!.core) as [Core, Core];
    await until(clock, () => allKnowEachOther([a, b]), 20_000);

    expect(a.identityView().joinedOn).toBeUndefined();
    a.updateProfile({ joinedOn: '2019-07-15' });
    expect(a.identityView().joinedOn).toBe('2019-07-15');
    await until(
      clock,
      () => b.people().find((p) => p.userId === a.userId)?.joinedOn === '2019-07-15',
      20_000,
    );

    a.updateProfile({ joinedOn: '2020-01-02' });
    await until(
      clock,
      () => b.people().find((p) => p.userId === a.userId)?.joinedOn === '2020-01-02',
      20_000,
    );

    // Cleared: gone for colleagues too, and the rest of the profile is untouched.
    a.updateProfile({ joinedOn: '' });
    expect(a.identityView().joinedOn).toBeUndefined();
    await until(
      clock,
      () => b.people().find((p) => p.userId === a.userId)?.joinedOn === undefined,
      20_000,
    );
    await run(clock, 200);
    expect(b.people().find((p) => p.userId === a.userId)?.displayName).toBe(
      a.identityView().displayName,
    );
  });
});

describe('M6.27 how long someone has been with the company', () => {
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 15, 0, 0);
  it('counts whole months, then years and months, and days under a month', () => {
    expect(tenure('2021-03-03', at(2026, 10, 30))).toEqual({ kind: 'months', years: 5, months: 7 });
    // The month is not complete until the day comes round.
    expect(tenure('2021-03-31', at(2026, 10, 30))).toEqual({ kind: 'months', years: 5, months: 6 });
    expect(tenure('2021-03-30', at(2026, 10, 30))).toEqual({ kind: 'months', years: 5, months: 7 });
    expect(tenure('2025-10-30', at(2026, 10, 30))).toEqual({ kind: 'months', years: 1, months: 0 });
    expect(tenure('2026-04-10', at(2026, 10, 30))).toEqual({ kind: 'months', years: 0, months: 6 });
    expect(tenure('2026-10-12', at(2026, 10, 30))).toEqual({ kind: 'days', days: 18 });
    expect(tenure('2026-10-29', at(2026, 10, 30))).toEqual({ kind: 'days', days: 1 });
    expect(tenure('2026-10-30', at(2026, 10, 30))).toEqual({ kind: 'today' });
    expect(tenure('2026-11-02', at(2026, 10, 30))).toEqual({ kind: 'future' });
    expect(tenure('not a date', at(2026, 10, 30))).toBeUndefined();
  });

  it('the day is read as the local day, in any time zone', () => {
    const d = joinedDate('2021-03-03');
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2021, 3, 3]);
  });
});

describe('M6.27 Remote Desktop Connection to a colleague', () => {
  const COLLEAGUE = 'a'.repeat(32);
  /** A protector that really changes the bytes (the test one passes them through), as DPAPI does. */
  const sealing: KeyProtector = {
    scheme: 'insecure-test',
    protect: async (plain) => Buffer.concat([Buffer.from('SEALED:'), Buffer.from(plain).reverse()]),
    unprotect: async (sealed) => Buffer.from(Buffer.from(sealed).subarray(7)).reverse(),
  };
  async function start(host: Partial<RemoteDesktopHost> | undefined) {
    const root = mkdtempSync(join(tmpdir(), 'intercom-rdp-'));
    const calls: Array<{
      op: string;
      address: string;
      login?: { username: string; password: string };
    }> = [];
    const remoteDesktop: RemoteDesktopHost | undefined = host && {
      connect: async (address, login) => {
        calls.push({ op: 'connect', address, ...(login && { login }) });
        await host.connect?.(address, login);
      },
      forget: async (address) => {
        calls.push({ op: 'forget', address });
      },
    };
    const core = await Core.start({
      dataDir: join(root, 'alice'),
      profile: 'alice',
      appVersion: '0.18.4',
      keyProtector: sealing,
      logger: silentLogger,
      defaultDisplayName: async () => 'Alice',
      host: {
        fixFirewall: async () => {},
        openNetworkSettings: () => {},
        ...(remoteDesktop && { remoteDesktop }),
      },
    });
    cleanups.push(async () => {
      await core.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });
    return { core, calls };
  }

  it('saves a sign-in sealed, never gives the password back, and uses it to connect', async () => {
    const { core, calls } = await start({});
    expect(core.remoteDesktopView(COLLEAGUE)).toMatchObject({ saved: false, custom: false });

    const view = await core.saveRemoteDesktop({
      userId: COLLEAGUE,
      address: '192.168.10.100',
      username: 'sam-home',
      password: 'Pa55 w"rd',
    });
    expect(view).toEqual({
      saved: true,
      username: 'sam-home',
      address: '192.168.10.100',
      custom: true,
    });
    expect(JSON.stringify(view)).not.toContain('Pa55');
    // On disk it is sealed: the password is not in the database in the clear.
    const row = core.store.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`rdp.${COLLEAGUE}`) as { value: string };
    expect(row.value).not.toContain('Pa55');
    const stored = JSON.parse(row.value) as { sealed: string };
    expect(Buffer.from(stored.sealed, 'base64').toString('utf8')).toMatch(/^SEALED:/);
    expect(Buffer.from(stored.sealed, 'base64').toString('utf8')).not.toContain('Pa55');

    expect(await core.connectRemoteDesktop(COLLEAGUE)).toEqual({ usedSaved: true });
    expect(calls).toEqual([
      {
        op: 'connect',
        address: '192.168.10.100',
        login: { username: 'sam-home', password: 'Pa55 w"rd' },
      },
    ]);
  });

  it('changing the user name keeps the password, and a first save needs one', async () => {
    const { core, calls } = await start({});
    await expect(
      core.saveRemoteDesktop({ userId: COLLEAGUE, address: '10.0.0.5', username: 'u' }),
    ).rejects.toThrow(/password/i);
    await core.saveRemoteDesktop({
      userId: COLLEAGUE,
      address: '10.0.0.5',
      username: 'u',
      password: 'one',
    });
    await core.saveRemoteDesktop({ userId: COLLEAGUE, address: '10.0.0.5', username: 'v' });
    await core.connectRemoteDesktop(COLLEAGUE);
    expect(calls.at(-1)).toMatchObject({ login: { username: 'v', password: 'one' } });
    // A new password replaces it.
    await core.saveRemoteDesktop({
      userId: COLLEAGUE,
      address: '10.0.0.5',
      username: 'v',
      password: 'two',
    });
    await core.connectRemoteDesktop(COLLEAGUE);
    expect(calls.at(-1)).toMatchObject({ login: { username: 'v', password: 'two' } });
  });

  it('with nothing saved it just opens the program at the address', async () => {
    const { core, calls } = await start({});
    await core.saveRemoteDesktop({
      userId: COLLEAGUE,
      address: '10.0.0.5',
      username: 'u',
      password: 'p',
    });
    await core.forgetRemoteDesktop(COLLEAGUE);
    expect(core.remoteDesktopView(COLLEAGUE)).toMatchObject({ saved: false, custom: false });
    // Taken out of Windows' Credential Manager too.
    expect(calls).toContainEqual({ op: 'forget', address: '10.0.0.5' });
    // Without a saved sign-in and without an address that InterCom knows, it says so.
    await expect(core.connectRemoteDesktop(COLLEAGUE)).rejects.toThrow(/does not know where/);
  });

  it('a new address takes the old Windows entry away', async () => {
    const { core, calls } = await start({});
    await core.saveRemoteDesktop({
      userId: COLLEAGUE,
      address: '10.0.0.5',
      username: 'u',
      password: 'p',
    });
    await core.saveRemoteDesktop({ userId: COLLEAGUE, address: 'office-pc-7', username: 'u' });
    expect(calls).toContainEqual({ op: 'forget', address: '10.0.0.5' });
    await core.connectRemoteDesktop(COLLEAGUE);
    expect(calls.at(-1)).toMatchObject({ op: 'connect', address: 'office-pc-7' });
  });

  it('cannot start anything where the host cannot', async () => {
    const { core } = await start(undefined);
    await expect(core.connectRemoteDesktop(COLLEAGUE)).rejects.toThrow(/cannot be started/);
  });

  it('where a colleague is reached is the address InterCom sees, unless one was typed', async () => {
    const clock = new FakeClock();
    const sim = await startInProcessPeers({ count: 2, clock });
    sims.push(sim);
    const [a, b] = [0, 1].map((i) => sim.peers[i]!.core) as [Core, Core];
    await until(clock, () => allKnowEachOther([a, b]), 20_000);
    const seen = a.people().find((p) => p.userId === b.userId)!;
    expect(seen.address ?? seen.machine?.host).toBeTruthy();
    const view = a.remoteDesktopView(b.userId);
    expect(view.custom).toBe(false);
    expect(view.address).toBe(seen.address ?? seen.machine?.host);
  });
});

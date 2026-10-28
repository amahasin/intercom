/**
 * M6.25: a new version from GitHub is installed by itself, quietly, but only at a good moment: not
 * while the user is in a call, moving files or has something typed that is not sent, and only when
 * they are away. The update service decides (`UpdateService`); the core says what the moment is
 * like (`Core.updateReadiness`). Nothing is installed without the moment having lasted a while, and
 * once more just before the installer starts.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core, silentLogger, systemClock } from '@officemesh/core';
import { FakeClock, InsecureTestKeyProtector } from '@officemesh/core/testing';
import type { UpdateStatus } from '@officemesh/protocol/ipc';
import {
  UpdateService,
  type InstallerBlocked,
  type Readiness,
} from '../../packages/core/src/updates/updates.ts';

const INSTALLER = Buffer.from('MZ pretend this is an installer '.repeat(2_000));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A GitHub whose newest release is `version`, with the installer for x64. */
function fakeGithub(version: string) {
  const name = `InterCom-Setup-${version}-x64.exe`;
  const release = {
    tag_name: `v${version}`,
    html_url: `https://github.com/example/intercom/releases/tag/v${version}`,
    assets: [
      {
        name,
        size: INSTALLER.length,
        digest: `sha256:${sha(INSTALLER)}`,
        browser_download_url: `https://github.com/example/intercom/releases/download/v${version}/${name}`,
      },
    ],
  };
  const seen: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    seen.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.github.com') return Response.json(release);
    if (u.hostname === 'github.com')
      return new Response(null, {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/x' },
      });
    return new Response(INSTALLER);
  };
  return { fetch, seen };
}

interface Options {
  autoInstall?: boolean;
  autoDownload?: boolean;
  /** Makes the signature check slow, so the moment can change while it runs. */
  verifyMs?: number;
  installerThrows?: boolean;
  /** Windows already refused the installer of this version (a start ago). */
  blocked?: InstallerBlocked;
}

function service(options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'intercom-autoinst-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const state = {
    readiness: 'busy' as Readiness,
    enabled: options.autoInstall ?? true,
    blocked: options.blocked,
  };
  const ran: string[] = [];
  const events: UpdateStatus[] = [];
  const gh = fakeGithub('0.19.0');
  const svc = new UpdateService({
    clock: systemClock,
    logger: silentLogger,
    appVersion: '0.18.2',
    arch: 'x64',
    folder: () => '',
    host: {
      verifySignature: async () => {
        if (options.verifyMs) await new Promise((r) => setTimeout(r, options.verifyMs));
        return { status: 'unsigned' };
      },
      runInstaller: (p) => {
        if (options.installerThrows) throw new Error('the installer could not start');
        ran.push(p);
      },
    },
    changed: (s) => events.push(s),
    github: {
      repo: 'example/intercom',
      enabled: () => true,
      autoDownload: () => options.autoDownload ?? true,
      autoInstall: {
        enabled: () => state.enabled,
        readiness: () => state.readiness,
        blocked: () => state.blocked,
        everyMs: 15,
        settleMs: 120,
      },
      fetch: gh.fetch,
      downloadDir: dir,
    },
  });
  svc.start();
  cleanups.push(() => svc.stop());
  return { svc, state, ran, events, gh };
}

const downloaded = (svc: UpdateService) =>
  vi.waitFor(() => expect(svc.current().downloaded).toBe(true), { timeout: 5_000 });

describe('M6.25 installing a new version by itself', () => {
  it('waits while the user is busy, says why, and installs once the moment has lasted a while', async () => {
    const { svc, state, ran } = service();
    await downloaded(svc);

    state.readiness = 'busy';
    await vi.waitFor(() => expect(svc.current().auto).toBe('busy'), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(ran).toEqual([]);

    state.readiness = 'active';
    await vi.waitFor(() => expect(svc.current().auto).toBe('active'), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(ran).toEqual([]);

    state.readiness = 'ready';
    await vi.waitFor(() => expect(svc.current().auto).toBe('soon'), { timeout: 2_000 });
    // Not at once: the moment has to last.
    expect(ran).toEqual([]);
    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 3_000 });
    expect(ran[0]).toMatch(/InterCom-Setup-0\.19\.0-x64\.exe$/);
  });

  it('starts the wait again when something gets in the way, however short', async () => {
    const { svc, state, ran } = service();
    await downloaded(svc);
    state.readiness = 'ready';
    await vi.waitFor(() => expect(svc.current().auto).toBe('soon'), { timeout: 2_000 });
    // A burst of work every 60 ms: the wait (120 ms) never completes.
    for (let i = 0; i < 12; i++) {
      state.readiness = 'busy';
      await new Promise((r) => setTimeout(r, 25));
      state.readiness = 'ready';
      await new Promise((r) => setTimeout(r, 35));
    }
    expect(ran).toEqual([]);
    // Left alone, it goes ahead.
    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 3_000 });
  });

  it('looks once more just before the installer starts: a call that began meanwhile stops it', async () => {
    const { svc, state, ran } = service({ verifyMs: 250 });
    await downloaded(svc);
    state.readiness = 'ready';
    // The wait is over and the signature check is under way...
    await vi.waitFor(() => expect(svc.current().state).toBe('available'), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 200));
    // ...a call comes in during it.
    state.readiness = 'busy';
    await new Promise((r) => setTimeout(r, 500));
    expect(ran).toEqual([]);
    expect(svc.current()).toMatchObject({ state: 'available', downloaded: true });
    expect(svc.current().error).toBeUndefined();
    // And when it is over, the update goes ahead.
    state.readiness = 'ready';
    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 4_000 });
  });

  it('does nothing by itself when turned off, and the user can still install it', async () => {
    const { svc, state, ran } = service({ autoInstall: false, autoDownload: true });
    await downloaded(svc);
    state.readiness = 'ready';
    await new Promise((r) => setTimeout(r, 400));
    expect(ran).toEqual([]);
    expect(svc.current().auto).toBeUndefined();
    await svc.install();
    expect(ran).toHaveLength(1);
  });

  it('fetches the installer by itself even when the download is not automatic: installing needs it', async () => {
    const { svc, state, ran } = service({ autoDownload: false });
    await downloaded(svc);
    state.readiness = 'ready';
    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 4_000 });
  });

  it('does not download by itself when neither is on', async () => {
    const { svc, gh } = service({ autoInstall: false, autoDownload: false });
    await svc.check();
    await new Promise((r) => setTimeout(r, 200));
    expect(svc.current().downloaded).toBeUndefined();
    expect(gh.seen.some((u) => u.includes('/releases/download/'))).toBe(false);
  });

  it('does not try again and again when the installer could not be started', async () => {
    const { svc, state, events } = service({ installerThrows: true });
    await downloaded(svc);
    state.readiness = 'ready';
    await vi.waitFor(() => expect(svc.current().error).toMatch(/could not be installed/), {
      timeout: 4_000,
    });
    const errors = events.filter((e) => e.error).length;
    await new Promise((r) => setTimeout(r, 600));
    // The failure is shown once; it is not tried again for half an hour.
    expect(events.filter((e) => e.error).length).toBe(errors);
  });

  it('does not start again, by itself, the installer that Windows refused, and says why', async () => {
    const { svc, state, ran } = service({ blocked: { version: '0.19.0', smartAppControl: true } });
    await downloaded(svc);
    state.readiness = 'ready';
    await new Promise((r) => setTimeout(r, 500));
    expect(ran).toEqual([]);
    expect(svc.current()).toMatchObject({ state: 'available', version: '0.19.0' });
    expect(svc.current().auto).toBeUndefined();
    expect(svc.current().error).toMatch(/Smart App Control/);
    // "Install and restart" still tries: the user may have turned it off since.
    await svc.install();
    expect(ran).toHaveLength(1);
  });

  it('says it differently when Smart App Control is not what is in the way', async () => {
    const { svc } = service({ blocked: { version: '0.19.0', smartAppControl: false } });
    await downloaded(svc);
    expect(svc.current().error).toMatch(/security software/);
    expect(svc.current().error).not.toMatch(/Smart App Control/);
  });

  it('a refused installer is for that version only: a newer one goes ahead', async () => {
    const { svc, state, ran } = service({ blocked: { version: '0.18.9', smartAppControl: true } });
    await downloaded(svc);
    expect(svc.current().error).toBeUndefined();
    state.readiness = 'ready';
    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 4_000 });
  });

  it('shows a refusal reported after the update was found, without waiting for the next check', async () => {
    const { svc, state } = service();
    await downloaded(svc);
    expect(svc.current().error).toBeUndefined();
    state.blocked = { version: '0.19.0', smartAppControl: true };
    svc.noteInstallerBlocked();
    expect(svc.current().error).toMatch(/Smart App Control/);
  });
});

describe('M6.25 what the core says about the moment', () => {
  async function core(clock: FakeClock): Promise<Core> {
    const root = mkdtempSync(join(tmpdir(), 'intercom-ready-'));
    const c = await Core.start({
      dataDir: join(root, 'alice'),
      profile: 'alice',
      appVersion: '0.18.2',
      keyProtector: new InsecureTestKeyProtector(),
      logger: silentLogger,
      clock,
      defaultDisplayName: async () => 'Alice',
    });
    cleanups.push(async () => {
      await c.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });
    return c;
  }

  it('is not a good moment while the user is at the app, and is once they are away', async () => {
    const clock = new FakeClock(1_000_000);
    const c = await core(clock);
    // A window in front, in use: not now.
    expect(c.updateReadiness()).toBe('active');
    // 5 minutes without keyboard or mouse (the host says so): away.
    c.setSystemState({ idle: true });
    expect(c.updateReadiness()).toBe('ready');
    c.setSystemState({ idle: false });
    expect(c.updateReadiness()).toBe('active');
    // The screen is locked.
    c.setSystemState({ locked: true });
    expect(c.updateReadiness()).toBe('ready');
    c.setSystemState({ locked: false });
    // The app is behind other windows: a moment is not enough, 2 minutes is.
    c.setSystemState({ foreground: false });
    clock.advance(60_000);
    expect(c.updateReadiness()).toBe('active');
    clock.advance(61_000);
    expect(c.updateReadiness()).toBe('ready');
    // Back in front: active again at once.
    c.setSystemState({ foreground: true });
    expect(c.updateReadiness()).toBe('active');
  });

  it('is never a good moment with something typed and not sent, even when the user is away', async () => {
    const clock = new FakeClock(1_000_000);
    const c = await core(clock);
    c.setSystemState({ idle: true });
    expect(c.updateReadiness()).toBe('ready');
    c.setActivity({ unsent: true });
    expect(c.busyWith()).toBe('unsent');
    expect(c.updateReadiness()).toBe('busy');
    // The window says it again every 30 seconds; it is believed for 90.
    clock.advance(60_000);
    expect(c.updateReadiness()).toBe('busy');
    // A window that went away without saying so stops holding the update after that.
    clock.advance(40_000);
    expect(c.busyWith()).toBeUndefined();
    expect(c.updateReadiness()).toBe('ready');
    // Cleared by the window itself.
    c.setActivity({ unsent: true });
    c.setActivity({ unsent: false });
    expect(c.updateReadiness()).toBe('ready');
  });

  it('the setting is on by default and can be turned off', async () => {
    const c = await core(new FakeClock(1_000_000));
    expect(c.settings().autoInstallUpdates).toBe(true);
    c.setSettings({ autoInstallUpdates: false });
    expect(c.settings().autoInstallUpdates).toBe(false);
  });
});

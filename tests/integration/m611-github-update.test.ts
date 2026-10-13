import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemClock } from '@officemesh/core';
import { UpdateService, type SignatureCheck } from '../../packages/core/src/updates/updates.ts';
import type { UpdateStatus } from '@officemesh/protocol/ipc';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const INSTALLER = Buffer.from('MZ pretend this is an installer '.repeat(5_000));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Release {
  tag_name: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: Array<{
    name: string;
    size: number;
    digest?: string;
    browser_download_url: string;
  }>;
}

function release(version: string, extra: Partial<Release> = {}, arch = 'x64'): Release {
  const name = `InterCom-Setup-${version}-${arch}.exe`;
  return {
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
    ...extra,
  };
}

/** A GitHub that answers the API with `latest`, and a download (by a redirect, like the real one). */
function fakeGithub(latest: Release | number | Error, bytes: Buffer = INSTALLER) {
  const seen: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    seen.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.github.com') {
      if (latest instanceof Error) throw latest;
      if (typeof latest === 'number') return new Response('{}', { status: latest });
      return Response.json(latest);
    }
    if (u.hostname === 'github.com' && u.pathname.includes('/releases/download/'))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/some/stored/file' },
      });
    if (u.hostname === 'release-assets.githubusercontent.com') return new Response(bytes);
    return new Response('nope', { status: 404 });
  };
  return { fetch, seen };
}

function service(
  github: ReturnType<typeof fakeGithub> | undefined,
  options: {
    folder?: string;
    enabled?: boolean;
    version?: string;
    ours?: SignatureCheck;
    theirs?: SignatureCheck;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'intercom-ghupd-'));
  const ran: string[] = [];
  const events: UpdateStatus[] = [];
  const svc = new UpdateService({
    clock: systemClock,
    logger: silent,
    appVersion: options.version ?? '0.13.0',
    arch: 'x64',
    folder: () => options.folder ?? '',
    host: {
      verifySignature: async (p) =>
        p === null
          ? (options.ours ?? { status: 'unsigned' })
          : (options.theirs ?? { status: 'unsigned' }),
      runInstaller: (p) => ran.push(p),
    },
    changed: (s) => events.push(s),
    ...(github && {
      github: {
        repo: 'example/intercom',
        enabled: () => options.enabled ?? true,
        fetch: github.fetch,
        downloadDir: dir,
      },
    }),
  });
  return { svc, ran, events, dir };
}

describe('M6.11 updates from a GitHub release', () => {
  it('offers a newer release for this architecture, not a required one unless it says so', async () => {
    const { svc } = service(fakeGithub(release('0.14.0')));
    expect(await svc.check()).toMatchObject({
      state: 'available',
      source: 'github',
      version: '0.14.0',
    });
    expect((await svc.check()).required).toBeUndefined();

    const asked = service(fakeGithub(release('0.14.0', { body: 'Fixes.\n\nintercom:required\n' })));
    expect(await asked.svc.check()).toMatchObject({ state: 'available', required: true });
  });

  it('offers nothing for the same or an older version, a draft, a pre-release, no release, or another architecture', async () => {
    for (const latest of [
      release('0.13.0'),
      release('0.12.0'),
      release('0.14.0', { draft: true }),
      release('0.14.0', { prerelease: true }),
      release('0.14.0', {}, 'arm64'),
      404,
    ])
      expect((await service(fakeGithub(latest)).svc.check()).state).toBe('none');
  });

  it('does not offer a release that has no checksum, and does not call an unreachable GitHub an error', async () => {
    const noSum = release('0.14.0');
    delete noSum.assets[0]!.digest;
    expect((await service(fakeGithub(noSum)).svc.check()).state).toBe('none');
    expect((await service(fakeGithub(new Error('getaddrinfo ENOTFOUND'))).svc.check()).state).toBe(
      'none',
    );
    expect((await service(fakeGithub(500)).svc.check()).state).toBe('none');
  });

  it('is off when the user turned it off, and without a folder', async () => {
    const gh = fakeGithub(release('0.14.0'));
    const off = service(gh, { enabled: false });
    expect((await off.svc.check()).state).toBe('off');
    expect(gh.seen).toEqual([]);
  });

  it('downloads the installer, checks it against the published checksum, and runs it', async () => {
    const gh = fakeGithub(release('0.14.0'));
    const { svc, ran, events } = service(gh);
    await svc.check();
    await svc.install();
    expect(ran).toHaveLength(1);
    expect(readFileSync(ran[0]!)).toEqual(INSTALLER);
    // Only GitHub's hosts were asked, including the one the download was redirected to.
    expect(new Set(gh.seen.map((u) => new URL(u).hostname))).toEqual(
      new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com']),
    );
    expect(events.some((e) => e.state === 'downloading')).toBe(true);
  });

  it('refuses and removes a download that is not the file GitHub published', async () => {
    const tampered = Buffer.from(INSTALLER);
    tampered[100] = tampered[100]! ^ 0xff;
    const { svc, ran, events, dir } = service(fakeGithub(release('0.14.0'), tampered));
    await svc.check();
    await expect(svc.install()).rejects.toThrow(/checksum/);
    expect(ran).toEqual([]);
    expect(existsSync(join(dir, 'InterCom-update', 'InterCom-Setup-0.14.0-x64.exe'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ state: 'available' });
    expect(events.at(-1)?.error).toMatch(/could not be installed/);

    // A file of the wrong length is refused too.
    const short = service(fakeGithub(release('0.14.0'), INSTALLER.subarray(0, 1_000)));
    await short.svc.check();
    await expect(short.svc.install()).rejects.toThrow(/size/);
  });

  it('never follows a redirect to a host that is not GitHub', async () => {
    const seen: string[] = [];
    const evil = async (url: string): Promise<Response> => {
      seen.push(url);
      const u = new URL(url);
      if (u.hostname === 'api.github.com') return Response.json(release('0.14.0'));
      if (u.hostname === 'github.com')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://example.invalid/x' },
        });
      return new Response(INSTALLER);
    };
    const { svc, ran } = service({ fetch: evil, seen });
    await svc.check();
    await expect(svc.install()).rejects.toThrow(/not GitHub/);
    expect(ran).toEqual([]);
    expect(seen.some((u) => u.includes('example.invalid'))).toBe(false);
  });

  it('a build that is signed takes only an installer from its own publisher', async () => {
    const wrong = service(fakeGithub(release('0.14.0')), {
      ours: { status: 'valid', publisher: 'CN=Us' },
      theirs: { status: 'valid', publisher: 'CN=Someone Else' },
    });
    await wrong.svc.check();
    await expect(wrong.svc.install()).rejects.toThrow(/publisher/);
    expect(wrong.ran).toEqual([]);
    const right = service(fakeGithub(release('0.14.0')), {
      ours: { status: 'valid', publisher: 'CN=Us' },
      theirs: { status: 'valid', publisher: 'CN=Us' },
    });
    await right.svc.check();
    await right.svc.install();
    expect(right.ran).toHaveLength(1);
  });

  it("the office's own folder comes first, and its update is required", async () => {
    const folder = mkdtempSync(join(tmpdir(), 'intercom-folder-'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'InterCom-Setup-0.13.5-x64.exe'), 'x');
    const gh = fakeGithub(release('0.14.0'));
    const { svc } = service(gh, { folder });
    expect(await svc.check()).toMatchObject({
      state: 'available',
      source: 'folder',
      version: '0.13.5',
      required: true,
    });
    // Nothing newer in the folder: GitHub is asked.
    const empty = mkdtempSync(join(tmpdir(), 'intercom-folder-'));
    const second = service(fakeGithub(release('0.14.0')), { folder: empty });
    expect(await second.svc.check()).toMatchObject({ source: 'github', version: '0.14.0' });
  });
});

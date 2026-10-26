/**
 * Updates from a GitHub release: the one place the app talks to the internet, on purpose.
 *
 * The check asks the GitHub API for the repository's latest (published, not draft or
 * pre-release) release, looks for the installer for this PC's architecture, and (when the user
 * installs) downloads it, checks that its SHA-256 is the one GitHub published for that file,
 * and hands it to the host to run. Only GitHub's own hosts are ever contacted, including when a
 * download is redirected to where the files are stored. Nothing about the user or the PC is sent
 * beyond what any web request carries (the address it comes from, and the name and version of
 * the app).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions } from './updates.ts';

/** Hosts a request may go to, directly or by redirect. Nothing else is followed. */
const GITHUB_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

/** The biggest installer that is accepted (the real ones are about 110 MB). */
export const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const API_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** A line in a release's text that makes its update required (the window cannot be closed). */
export const REQUIRED_MARKER = 'intercom:required';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubRelease {
  version: string;
  tag: string;
  /** The release page, for "what is new". */
  pageUrl: string;
  /** The installer for this architecture. */
  asset: { name: string; url: string; size: number; sha256: string };
  /** The release's text asks for this update to be installed before the app is used further. */
  required: boolean;
}

interface ApiAsset {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
}

const INSTALLER_NAME = /^InterCom-Setup-(\d+\.\d+\.\d+)-(x64|arm64)\.exe$/i;

function isGithubUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && GITHUB_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** A GET that follows redirects by hand, and only to GitHub's hosts. */
async function get(
  fetch: Fetch,
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isGithubUrl(target)) throw new Error('the update server is not GitHub');
    const res = await fetch(target, {
      redirect: 'manual',
      headers: { 'user-agent': userAgent, accept: 'application/vnd.github+json, */*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error('GitHub sent a redirect without a place to go');
      target = new URL(next, target).href;
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

/** "sha256:ab12..." as GitHub gives it for a release file, or undefined. */
function digestOf(asset: ApiAsset): string | undefined {
  if (typeof asset.digest !== 'string') return undefined;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
  return m?.[1]?.toLowerCase();
}

/** The checksum list some releases carry instead: lines of "<sha256>  <file name>". */
function parseChecksums(text: string, file: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && m[2] === file) return m[1]!.toLowerCase();
  }
  return undefined;
}

/**
 * The latest release, if it is newer than `current` and has an installer for `arch` whose
 * checksum is known. `undefined` means nothing newer. A newer release that cannot be trusted (no
 * checksum published) is an error, not "nothing".
 */
export async function findGithubRelease(options: {
  repo: string;
  current: string;
  arch: string;
  userAgent: string;
  fetch?: Fetch;
}): Promise<GithubRelease | undefined> {
  const fetch = options.fetch ?? globalThis.fetch;
  const { repo, userAgent } = options;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('the update repository is not valid');
  const res = await get(
    fetch,
    `https://api.github.com/repos/${repo}/releases/latest`,
    userAgent,
    API_TIMEOUT_MS,
  );
  // No release yet.
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    body?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
  };
  if (body.draft === true || body.prerelease === true) return undefined;
  const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!version) return undefined;
  if (compareVersions(version, options.current) <= 0) return undefined;
  const assets = Array.isArray(body.assets) ? (body.assets as ApiAsset[]) : [];
  const installer = assets.find((a) => {
    const m = typeof a.name === 'string' ? INSTALLER_NAME.exec(a.name) : null;
    return m?.[1] === version && m[2]!.toLowerCase() === options.arch;
  });
  if (!installer || typeof installer.name !== 'string') return undefined;
  const url = installer.browser_download_url;
  const size = typeof installer.size === 'number' ? installer.size : 0;
  if (typeof url !== 'string' || !isGithubUrl(url)) throw new Error('the installer has no address');
  if (size <= 0 || size > MAX_INSTALLER_BYTES) throw new Error('the installer is not a usual size');

  let sha256 = digestOf(installer);
  if (!sha256) {
    const sums = assets.find((a) => a.name === 'SHA256SUMS.txt');
    if (sums && typeof sums.browser_download_url === 'string') {
      const r = await get(fetch, sums.browser_download_url, userAgent, API_TIMEOUT_MS);
      if (r.ok) sha256 = parseChecksums((await r.text()).slice(0, 64 * 1024), installer.name);
    }
  }
  if (!sha256) throw new Error('GitHub has no checksum for the installer, so it is not offered');
  const text = typeof body.body === 'string' ? body.body : '';
  return {
    version,
    tag,
    pageUrl: typeof body.html_url === 'string' && isGithubUrl(body.html_url) ? body.html_url : '',
    asset: { name: installer.name, url, size, sha256 },
    required: text.toLowerCase().includes(REQUIRED_MARKER),
  };
}

/**
 * Download the release's installer to `file`, checking its size and SHA-256 as it arrives. The
 * file is removed if either is wrong. `progress` is told how many bytes have arrived.
 */
export async function downloadInstaller(options: {
  release: GithubRelease;
  file: string;
  userAgent: string;
  fetch?: Fetch;
  progress?: (received: number, total: number) => void;
}): Promise<void> {
  const fetch = options.fetch ?? globalThis.fetch;
  const { release, file } = options;
  const res = await get(fetch, release.asset.url, options.userAgent, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status}`);
  await mkdir(dirname(file), { recursive: true });
  const hash = createHash('sha256');
  let received = 0;
  const source = Readable.fromWeb(res.body as never);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_INSTALLER_BYTES) source.destroy(new Error('the download is too big'));
    hash.update(chunk);
    options.progress?.(received, release.asset.size);
  });
  try {
    await pipeline(source, createWriteStream(file));
    if (received !== release.asset.size)
      throw new Error('the download is not the size it should be');
    if (hash.digest('hex') !== release.asset.sha256)
      throw new Error('the download does not match the checksum GitHub published');
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }
}

/**
 * Whether `file` is, byte for byte, the release's installer (its size and SHA-256 are the ones
 * GitHub published). Used before an installer that was downloaded earlier is run: it sat on disk
 * since, and only a file that still matches is started.
 */
export async function matchesRelease(release: GithubRelease, file: string): Promise<boolean> {
  try {
    if ((await stat(file)).size !== release.asset.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex') === release.asset.sha256;
  } catch {
    return false;
  }
}

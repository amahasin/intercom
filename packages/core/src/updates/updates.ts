/**
 * Updates without a server (plan section 15, M6): Settings can name a shared folder (for
 * example `\\fileserver\apps\intercom`); every few minutes the app looks there for a newer
 * installer for this PC's architecture, checks its Authenticode signature, and offers it (the
 * window then asks for it to be installed before the app is used any further). Otherwise, and when
 * the folder has nothing newer, it looks in the project's GitHub releases (`github.ts`), which is
 * offered as a banner (a release can ask for more: see `REQUIRED_MARKER`).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateStatus } from '@officemesh/protocol/ipc';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';
import {
  downloadInstaller,
  findGithubRelease,
  matchesRelease,
  type Fetch,
  type GithubRelease,
} from './github.ts';

export type SignatureCheck = { status: 'valid' | 'unsigned' | 'invalid'; publisher?: string };

/** What only the host can do: check Authenticode signatures and run an installer. */
export interface UpdateHost {
  /** The signature of a file, or of this running app when `path` is null. */
  verifySignature?(path: string | null): Promise<SignatureCheck>;
  runInstaller?(path: string): void;
}

/** An update is mandatory, so the folder is looked at often (a folder listing costs nothing). */
const CHECK_EVERY_MS = 10 * 60_000;
const TICK_MS = 2 * 60_000;
/** GitHub is asked far less often (its API allows 60 requests an hour from one address). */
const GITHUB_CHECK_EVERY_MS = 6 * 60 * 60_000;
/** After GitHub could not be reached (no internet here), try again after this long. */
const GITHUB_RETRY_MS = 30 * 60_000;
/** "Check for updates" asks GitHub right away, but not more often than this (a double click, a held key). */
const GITHUB_MANUAL_MIN_GAP_MS = 30_000;
const INSTALLER = /^(?:InterCom|OfficeMesh)-Setup-(\d+)\.(\d+)\.(\d+)-(x64|arm64)\.exe$/i;

/** Compare dotted versions numerically ("0.10.0" > "0.9.3"); non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function isVersion(text: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(text);
}

/** The newest installer in `folder` for `arch` that is newer than `current`. */
export async function findNewerInstaller(
  folder: string,
  current: string,
  arch: string,
): Promise<{ version: string; file: string } | undefined> {
  let best: { version: string; file: string } | undefined;
  for (const name of await readdir(folder)) {
    const m = INSTALLER.exec(name);
    if (!m || m[4]!.toLowerCase() !== arch) continue;
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    if (compareVersions(version, current) <= 0) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    const file = join(folder, name);
    if (!(await stat(file)).isFile()) continue;
    best = { version, file };
  }
  return best;
}

export class UpdateService {
  private status: UpdateStatus = { state: 'off' };
  private timer: TimerHandle | undefined;
  private running: Promise<UpdateStatus> | undefined;
  private release: GithubRelease | undefined;
  private githubCheckedAt = 0;
  private installing = false;
  /** The installer of the release found, once it is on this PC (downloaded in the background). */
  private downloaded: { version: string; file: string } | undefined;
  /** When the background download was last started (a failed one is tried again after a while). */
  private autoTriedAt = 0;
  private readonly o: {
    clock: Clock;
    logger: Logger;
    appVersion: string;
    arch: string;
    folder: () => string;
    host: UpdateHost;
    changed: (s: UpdateStatus) => void;
    /** Updates from a GitHub release: the repository (owner/name) and whether the user allows it. */
    github?: {
      repo: string;
      enabled: () => boolean;
      /** Fetch a new version as soon as it is found, so installing it takes a moment (on by default). */
      autoDownload?: () => boolean;
      fetch?: Fetch;
      downloadDir?: string;
    };
  };

  constructor(options: UpdateService['o']) {
    this.o = options;
  }

  start(): void {
    this.timer = this.o.clock.setInterval(() => {
      if (this.installing) return;
      const last = this.status.checkedAt ?? 0;
      if (this.o.clock.now() - last >= CHECK_EVERY_MS) void this.check();
    }, TICK_MS);
    void this.check();
  }

  stop(): void {
    if (this.timer) this.o.clock.clearInterval(this.timer);
  }

  current(): UpdateStatus {
    return this.status;
  }

  private set(next: UpdateStatus): UpdateStatus {
    this.status = next;
    this.o.changed(next);
    return next;
  }

  /**
   * Look for an update. `manual` (the user pressed "Check for updates") asks GitHub now instead
   * of waiting for its 6 hours to pass, and says so when GitHub cannot be reached.
   */
  check(manual = false): Promise<UpdateStatus> {
    if (this.running) {
      // A check is under way; a manual one starts after it so it is not answered from before the press.
      if (!manual) return this.running;
      const again = () => this.check(true);
      return this.running.then(again, again);
    }
    this.running = this.run(manual).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(manual: boolean): Promise<UpdateStatus> {
    if (this.installing) return this.status;
    if (!isVersion(this.o.appVersion)) return this.set({ state: 'off' });
    const folder = this.o.folder().trim();
    const github = this.o.github?.enabled() === true;
    if (!folder && !github) return this.set({ state: 'off' });
    this.set({ ...this.status, state: 'checking' });
    const checkedAt = this.o.clock.now();
    let result: UpdateStatus | undefined;
    if (folder) result = await this.runFolder(folder, checkedAt);
    // The office's own folder comes first; GitHub is asked when it has nothing newer.
    if (github && result?.state !== 'available') {
      const found = await this.runGithub(checkedAt, manual);
      if (found) result = found;
    }
    return this.set(result ?? { state: 'none', checkedAt });
  }

  private async runGithub(checkedAt: number, manual: boolean): Promise<UpdateStatus | undefined> {
    const github = this.o.github!;
    const since = checkedAt - this.githubCheckedAt;
    if (
      this.githubCheckedAt === 0 ||
      since >= GITHUB_CHECK_EVERY_MS ||
      (manual && since >= GITHUB_MANUAL_MIN_GAP_MS)
    ) {
      this.githubCheckedAt = checkedAt;
      try {
        this.release = await findGithubRelease({
          repo: github.repo,
          current: this.o.appVersion,
          arch: this.o.arch,
          userAgent: `InterCom/${this.o.appVersion}`,
          ...(github.fetch && { fetch: github.fetch }),
        });
      } catch (err) {
        // No internet on this network is ordinary, not an error to show: ask again a bit later.
        this.release = undefined;
        this.githubCheckedAt = checkedAt - GITHUB_CHECK_EVERY_MS + GITHUB_RETRY_MS;
        this.o.logger.info('update check on GitHub failed', { err: String(err) });
        // The automatic check stays quiet (no internet on this network is ordinary); someone who
        // pressed the button wants to know why nothing was found.
        if (manual)
          return {
            state: 'error',
            source: 'github',
            checkedAt,
            error: `The check on GitHub did not work: ${err instanceof Error ? err.message : String(err)}. Check the internet connection and try again.`,
          };
      }
    }
    const r = this.release;
    if (!r) return undefined;
    const have = this.downloaded?.version === r.version;
    const out: UpdateStatus = {
      state: 'available',
      source: 'github',
      version: r.version,
      ...(have && { downloaded: true }),
      // Checked by its SHA-256 as it downloads; signed only if the office signs its builds.
      signature: 'unsigned',
      ...(r.pageUrl && { releaseUrl: r.pageUrl }),
      ...(r.required && { required: true }),
      checkedAt,
    };
    if (!have && github.autoDownload?.() === true && !this.installing)
      this.startAutoDownload(r, out);
    return out;
  }

  private async runFolder(folder: string, checkedAt: number): Promise<UpdateStatus> {
    try {
      const found = await findNewerInstaller(folder, this.o.appVersion, this.o.arch);
      if (!found) return { state: 'none', source: 'folder', checkedAt };
      const verify = this.o.host.verifySignature;
      const [theirs, ours] = verify
        ? await Promise.all([verify(found.file), verify(null)])
        : [{ status: 'unsigned' as const }, { status: 'unsigned' as const }];
      // A signed build accepts only an installer signed by the same publisher; an unsigned
      // build (no office certificate) accepts an unsigned one, and says so.
      const signature: 'valid' | 'unsigned' | 'invalid' =
        theirs.status === 'invalid'
          ? 'invalid'
          : ours.status === 'valid'
            ? theirs.status === 'valid' && theirs.publisher === ours.publisher
              ? 'valid'
              : 'invalid'
            : theirs.status;
      if (signature === 'invalid')
        this.o.logger.warn('update installer signature rejected', { file: found.file });
      return {
        state: signature === 'invalid' ? 'error' : 'available',
        source: 'folder',
        // The office's own folder is the office's wish: its updates are required.
        required: true,
        version: found.version,
        file: found.file,
        signature,
        ...(theirs.publisher && { publisher: theirs.publisher }),
        checkedAt,
        ...(signature === 'invalid' && {
          error: `The installer for ${found.version} is not signed by this app's publisher.`,
        }),
      };
    } catch (err) {
      return {
        state: 'error',
        source: 'folder',
        checkedAt,
        error: `The update folder could not be read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Install what the last check found: run the installer from the folder, or download the
   * release's installer first (checked against the SHA-256 GitHub published for it). The host
   * closes the app for it.
   */
  async install(): Promise<void> {
    if (this.status.state !== 'available') throw new Error('no update is ready to install');
    if (!this.o.host.runInstaller) throw new Error('installing is not possible here');
    if (this.status.source !== 'github') {
      if (!this.status.file) throw new Error('no update is ready to install');
      this.o.host.runInstaller(this.status.file);
      return;
    }
    const release = this.release;
    const github = this.o.github;
    if (!release || !github || this.installing) throw new Error('no update is ready to install');
    this.installing = true;
    const base = this.status;
    const file = this.installerPath(release);
    try {
      // Already on this PC (downloaded in the background): only a file that still is the
      // release's installer is started, otherwise it is fetched again.
      const ready =
        this.downloaded?.version === release.version && (await matchesRelease(release, file));
      if (!ready) {
        this.downloaded = undefined;
        await this.download(release, file, base);
      }
      // A build that is signed accepts only an installer from its own publisher.
      const verify = this.o.host.verifySignature;
      if (verify) {
        const [theirs, ours] = await Promise.all([verify(file), verify(null)]);
        if (
          theirs.status === 'invalid' ||
          (ours.status === 'valid' &&
            (theirs.status !== 'valid' || theirs.publisher !== ours.publisher))
        )
          throw new Error('the installer is not signed by this app’s publisher');
      }
      this.set({ ...base });
      this.o.host.runInstaller(file);
    } catch (err) {
      this.set({
        ...base,
        error: `The update could not be installed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    } finally {
      this.installing = false;
    }
  }

  private installerPath(release: GithubRelease): string {
    return join(this.o.github?.downloadDir ?? tmpdir(), 'InterCom-update', release.asset.name);
  }

  /** Download the release's installer to `file`, telling the status how far it is. */
  private async download(release: GithubRelease, file: string, base: UpdateStatus): Promise<void> {
    const github = this.o.github!;
    this.set({ ...base, state: 'downloading', progress: 0 });
    let last = 0;
    await downloadInstaller({
      release,
      file,
      userAgent: `InterCom/${this.o.appVersion}`,
      ...(github.fetch && { fetch: github.fetch }),
      progress: (received, total) => {
        const percent = Math.floor((received * 100) / total);
        if (percent >= last + 2) {
          last = percent;
          this.set({ ...base, state: 'downloading', progress: percent });
        }
      },
    });
  }

  /**
   * A new version was found on GitHub: fetch it now, in the background, so that "Install and
   * restart" takes a moment instead of a download. Checked against the SHA-256 GitHub published
   * (and the publisher, in a signed build) before it is called ready; a download that fails is
   * tried again after a while, quietly (the version is still offered, and installing it
   * downloads it then).
   */
  private startAutoDownload(release: GithubRelease, base: UpdateStatus): void {
    const now = this.o.clock.now();
    if (this.installing || now - this.autoTriedAt < GITHUB_RETRY_MS) return;
    this.autoTriedAt = now;
    this.installing = true;
    const file = this.installerPath(release);
    void (async () => {
      try {
        // One installer on disk: older ones (downloaded for versions since passed) go.
        const dir = join(file, '..');
        for (const name of await readdir(dir).catch(() => [] as string[]))
          if (INSTALLER.test(name) && name !== release.asset.name)
            await rm(join(dir, name), { force: true }).catch(() => {});
        if (!(await matchesRelease(release, file))) await this.download(release, file, base);
        const verify = this.o.host.verifySignature;
        if (verify) {
          const [theirs, ours] = await Promise.all([verify(file), verify(null)]);
          if (
            theirs.status === 'invalid' ||
            (ours.status === 'valid' &&
              (theirs.status !== 'valid' || theirs.publisher !== ours.publisher))
          )
            throw new Error('the installer is not signed by this app’s publisher');
        }
        this.downloaded = { version: release.version, file };
        this.set({ ...base, state: 'available', downloaded: true });
      } catch (err) {
        await rm(file, { force: true }).catch(() => {});
        this.o.logger.info('background download of the update failed', { err: String(err) });
        this.set({ ...base });
      } finally {
        this.installing = false;
      }
    })();
  }
}

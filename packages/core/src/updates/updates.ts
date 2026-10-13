/**
 * Updates without a server (plan section 15, M6): Settings can name a shared folder (for
 * example `\\fileserver\apps\intercom`); every few minutes the app looks there for a newer
 * installer for this PC's architecture, checks its Authenticode signature, and offers it (the
 * window then asks for it to be installed before the app is used any further). Otherwise, and when
 * the folder has nothing newer, it looks in the project's GitHub releases (`github.ts`), which is
 * offered as a banner (a release can ask for more: see `REQUIRED_MARKER`).
 */
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateStatus } from '@officemesh/protocol/ipc';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';
import { downloadInstaller, findGithubRelease, type Fetch, type GithubRelease } from './github.ts';

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
  private readonly o: {
    clock: Clock;
    logger: Logger;
    appVersion: string;
    arch: string;
    folder: () => string;
    host: UpdateHost;
    changed: (s: UpdateStatus) => void;
    /** Updates from a GitHub release: the repository (owner/name) and whether the user allows it. */
    github?: { repo: string; enabled: () => boolean; fetch?: Fetch; downloadDir?: string };
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

  check(): Promise<UpdateStatus> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<UpdateStatus> {
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
      const found = await this.runGithub(checkedAt);
      if (found) result = found;
    }
    return this.set(result ?? { state: 'none', checkedAt });
  }

  private async runGithub(checkedAt: number): Promise<UpdateStatus | undefined> {
    const github = this.o.github!;
    if (this.githubCheckedAt === 0 || checkedAt - this.githubCheckedAt >= GITHUB_CHECK_EVERY_MS) {
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
      }
    }
    const r = this.release;
    if (!r) return undefined;
    return {
      state: 'available',
      source: 'github',
      version: r.version,
      // Checked by its SHA-256 as it downloads; signed only if the office signs its builds.
      signature: 'unsigned',
      ...(r.pageUrl && { releaseUrl: r.pageUrl }),
      ...(r.required && { required: true }),
      checkedAt,
    };
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
    const file = join(github.downloadDir ?? tmpdir(), 'InterCom-update', release.asset.name);
    try {
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
}

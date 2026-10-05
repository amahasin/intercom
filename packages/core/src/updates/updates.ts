/**
 * Updates without a server (plan section 15, M6): Settings names a shared folder (for
 * example `\\fileserver\apps\officemesh`); once a day the app looks there for a newer
 * installer for this PC's architecture, checks its Authenticode signature, and offers it.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateStatus } from '@officemesh/protocol/ipc';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';

export type SignatureCheck = { status: 'valid' | 'unsigned' | 'invalid'; publisher?: string };

/** What only the host can do: check Authenticode signatures and run an installer. */
export interface UpdateHost {
  /** The signature of a file, or of this running app when `path` is null. */
  verifySignature?(path: string | null): Promise<SignatureCheck>;
  runInstaller?(path: string): void;
}

const CHECK_EVERY_MS = 24 * 60 * 60_000;
const TICK_MS = 60 * 60_000;
const INSTALLER = /^OfficeMesh-Setup-(\d+)\.(\d+)\.(\d+)-(x64|arm64)\.exe$/i;

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
  private readonly o: {
    clock: Clock;
    logger: Logger;
    appVersion: string;
    arch: string;
    folder: () => string;
    host: UpdateHost;
    changed: (s: UpdateStatus) => void;
  };

  constructor(options: UpdateService['o']) {
    this.o = options;
  }

  start(): void {
    this.timer = this.o.clock.setInterval(() => {
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
    const folder = this.o.folder().trim();
    if (!folder) return this.set({ state: 'off' });
    if (!isVersion(this.o.appVersion)) return this.set({ state: 'off' });
    this.set({ ...this.status, state: 'checking' });
    const checkedAt = this.o.clock.now();
    try {
      const found = await findNewerInstaller(folder, this.o.appVersion, this.o.arch);
      if (!found) return this.set({ state: 'none', checkedAt });
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
      return this.set({
        state: signature === 'invalid' ? 'error' : 'available',
        version: found.version,
        file: found.file,
        signature,
        ...(theirs.publisher && { publisher: theirs.publisher }),
        checkedAt,
        ...(signature === 'invalid' && {
          error: `The installer for ${found.version} is not signed by this app's publisher.`,
        }),
      });
    } catch (err) {
      return this.set({
        state: 'error',
        checkedAt,
        error: `The update folder could not be read: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** Run the installer found by the last check; the host closes the app for it. */
  install(): void {
    if (this.status.state !== 'available' || !this.status.file)
      throw new Error('no update is ready to install');
    if (!this.o.host.runInstaller) throw new Error('installing is not possible here');
    this.o.host.runInstaller(this.status.file);
  }
}

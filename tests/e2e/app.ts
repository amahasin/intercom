import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const appDir = resolve(import.meta.dirname, '../../apps/desktop');
export const electronPath = createRequire(join(appDir, 'package.json'))(
  'electron',
) as unknown as string;

export function tempDataRoot(): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'officemesh-e2e-'));
  return {
    path,
    dispose: () => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

export interface RunningApp {
  app: ElectronApplication;
  window: Page;
  close: () => Promise<void>;
}

export async function launchApp(profile: string, dataRoot: string): Promise<RunningApp> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [appDir, `--profile=${profile}`, `--data-root=${dataRoot}`],
  });
  const window = await app.firstWindow();
  return { app, window, close: () => app.close() };
}

/** Launch without Playwright attached and report how the process ended. */
export function runRaw(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(electronPath, [appDir, ...args], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: null, timedOut: true });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut: false });
    });
  });
}

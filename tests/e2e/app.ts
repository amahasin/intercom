import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

export const appDir = resolve(import.meta.dirname, '../../apps/desktop');
export const electronPath = createRequire(join(appDir, 'package.json'))(
  'electron',
) as unknown as string;

export function tempDataRoot(): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'officemesh-e2e-'));
  return {
    path,
    dispose: () => {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // A killed process can hold its folder for a few seconds; the OS temp cleaner gets it.
      }
    },
  };
}

export interface RunningApp {
  app: ElectronApplication;
  window: Page;
  close: () => Promise<void>;
}

export async function launchApp(
  profile: string,
  dataRoot: string,
  extraArgs: string[] = [],
): Promise<RunningApp> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [
      appDir,
      `--profile=${profile}`,
      `--data-root=${dataRoot}`,
      // Received files land here, never in the real Downloads folder.
      `--downloads-dir=${join(dataRoot, 'downloads')}`,
      ...extraArgs,
    ],
  });
  const window = await app.firstWindow();
  return { app, window, close: () => app.close() };
}

/**
 * The page of this app's call window ('call') or of the small window that rings for an
 * incoming call ('incoming'), once it has opened. Calls no longer happen in the main window.
 */
export async function windowWithRole(
  app: ElectronApplication,
  role: 'call' | 'incoming',
  timeoutMs = 20_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = app.windows().find((w) => !w.isClosed() && w.url().includes(`role=${role}`));
    if (found) {
      await found.waitForLoadState('domcontentloaded');
      // The page is usable once its call engine has started (it publishes its test hooks).
      await found.waitForFunction(
        () => 'officemeshSounds' in window && 'officemeshCallStats' in window,
        undefined,
        { timeout: Math.max(1_000, deadline - Date.now()) },
      );
      return found;
    }
    if (Date.now() > deadline) throw new Error(`no ${role} window opened within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** How many windows of this role are open. */
export const windowCount = (app: ElectronApplication, role: 'call' | 'incoming') =>
  app.windows().filter((w) => !w.isClosed() && w.url().includes(`role=${role}`)).length;

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

/**
 * Flags that keep an app instance on a private loopback "LAN": its own beacon port, any
 * free link port, and a fixed firewall answer so tests never touch the real network.
 */
export function lanArgs(
  discoveryPort: number,
  firewall: 'ok' | 'missing' | 'public' = 'ok',
): string[] {
  return [
    `--discovery-port=${discoveryPort}`,
    '--link-port=0',
    '--lan=loopback',
    `--firewall-status=${firewall}`,
  ];
}

export function randomPort(): number {
  return 42_000 + Math.floor(Math.random() * 6_000);
}

/** Open the chat with someone: the people are on the People rail, so go there and pick them. */
export async function clickPerson(
  page: Page,
  userId: string | undefined,
  options?: Parameters<Locator['click']>[0],
): Promise<void> {
  await page.getByTestId('rail-people').click();
  await page.getByTestId(`person-${userId}`).click(options);
}

/** The rail a page is on (its current button in the rail). */
async function currentRail(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector('nav[aria-label="Apps"] [aria-current="page"]')
        ?.getAttribute('data-testid')
        ?.replace('rail-', '') ?? null,
  );
}

/**
 * Expectations about someone's row in the People list: the page goes to the People rail for the
 * check and comes back to the rail it was on.
 */
export function expectPerson(page: Page, userId: string | undefined) {
  const run = async (check: (row: Locator) => Promise<void>): Promise<void> => {
    const before = await currentRail(page);
    await page.getByTestId('rail-people').click();
    try {
      await check(page.getByTestId(`person-${userId}`));
    } finally {
      // Back where it was (the chat rail, if it had not shown its rail yet).
      const back = before ?? 'chat';
      if (back !== 'people') await page.getByTestId(`rail-${back}`).click();
    }
  };
  return {
    toHaveAttribute: (name: string, value: string, options?: { timeout?: number }) =>
      run((row) => expect(row).toHaveAttribute(name, value, options)),
    toHaveCount: (count: number, options?: { timeout?: number }) =>
      run((row) => expect(row).toHaveCount(count, options)),
    toBeVisible: (options?: { timeout?: number }) => run((row) => expect(row).toBeVisible(options)),
  };
}

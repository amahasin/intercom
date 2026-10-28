import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import { clickPerson, expectPerson, lanArgs, launchApp, randomPort, tempDataRoot } from './app.ts';

/**
 * M6.25: what the app does when an update is installed. The installer must not start while the app
 * is still closing (the core shuts its database down first), it gets electron-builder's quiet
 * switches, and an app nobody was looking at comes back to the tray rather than in front of the
 * user. A small stand-in for the installer (built with the C# compiler that is part of Windows)
 * records what it finds when it starts.
 */

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

interface Hooked {
  __officemeshTest: { windowVisible(): boolean; hideWindow(): void };
}

/** A program that notes its arguments, and whether the profile's database can be opened for writing. */
function standInInstaller(folder: string, database: string, report: string): string {
  const src = join(folder, 'installer.cs');
  const esc = (s: string) => s.replaceAll('\\', '\\\\');
  writeFileSync(
    src,
    `using System;
using System.IO;
class P {
  static void Main(string[] args) {
    string free;
    try {
      using (var f = File.Open("${esc(database)}", FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { free = "free"; }
    } catch (IOException) { free = "locked"; }
    File.WriteAllText("${esc(report)}", string.Join(" ", args) + "|" + free);
  }
}
`,
  );
  const exe = join(folder, 'InterCom-Setup-9.0.0-x64.exe');
  execFileSync(CSC, ['/nologo', `/out:${exe}`, src], { stdio: 'ignore' });
  return exe;
}

/** The profile made once (so its database exists), then pointed at a folder of installers. */
async function prepare(root: string, port: number, updates: string): Promise<void> {
  const first = await launchApp('alice', root, lanArgs(port));
  await expect(first.window.getByTestId('core-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  });
  await first.close();
  const db = new DatabaseSync(join(root, 'alice', 'officemesh.db'));
  try {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('updates.folder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify(updates));
  } finally {
    db.close();
  }
}

async function until(what: string, ms: number, check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.describe('M6.25 installing an update', () => {
  test('the installer starts after the app has closed its database, with the quiet switches', async () => {
    test.setTimeout(120_000);
    const root = tempDataRoot();
    const folder = mkdtempSync(join(tmpdir(), 'intercom-e2e-installer-'));
    const report = join(folder, 'report.txt');
    const port = randomPort();
    try {
      standInInstaller(folder, join(root.path, 'alice', 'officemesh.db'), report);
      await prepare(root.path, port, folder);
      const run = await launchApp('alice', root.path, lanArgs(port));
      const dialog = run.window.getByTestId('update-required');
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await run.window.getByTestId('update-required-install').click();
      await until('the installer to run', 30_000, () => existsSync(report));
      // Its switches: quiet, and start the app again; and when it started the core had closed
      // the database (the installer is started from the app's `will-quit` event, not before).
      expect(readFileSync(report, 'utf8')).toBe('--updated /S --force-run|free');
      await run.app.waitForEvent('close', { timeout: 15_000 }).catch(() => {});
    } finally {
      root.dispose();
    }
  });

  test('an app nobody was looking at comes back to the tray, and a start after that is normal', async () => {
    test.setTimeout(150_000);
    const root = tempDataRoot();
    const folder = mkdtempSync(join(tmpdir(), 'intercom-e2e-installer-'));
    const report = join(folder, 'report.txt');
    const port = randomPort();
    const marker = join(root.path, 'restart-hidden');
    try {
      standInInstaller(folder, join(root.path, 'alice', 'officemesh.db'), report);
      await prepare(root.path, port, folder);
      const run = await launchApp('alice', root.path, lanArgs(port));
      await expect(run.window.getByTestId('update-required')).toBeVisible({ timeout: 30_000 });
      // In the tray, not in front of anyone.
      await run.app.evaluate(() => (globalThis as unknown as Hooked).__officemeshTest.hideWindow());
      await run.window.getByTestId('update-required-install').dispatchEvent('click');
      await until('the installer to run', 30_000, () => existsSync(report));
      expect(existsSync(marker)).toBe(true);
      expect(Date.now() - Number(readFileSync(marker, 'utf8'))).toBeLessThan(60_000);

      // The app the installer starts again: no window, and the note is used up.
      const again = await launchApp('alice', root.path, lanArgs(port));
      try {
        await expect(again.window.getByTestId('core-status')).toHaveAttribute(
          'data-state',
          'ready',
          { timeout: 30_000 },
        );
        expect(
          await again.app.evaluate(() =>
            (globalThis as unknown as Hooked).__officemeshTest.windowVisible(),
          ),
        ).toBe(false);
        expect(existsSync(marker)).toBe(false);
      } finally {
        await again.close();
      }

      // And the start after that is an ordinary one: the window opens.
      mkdirSync(root.path, { recursive: true });
      const normal = await launchApp('alice', root.path, lanArgs(port));
      try {
        await expect(normal.window.getByTestId('core-status')).toHaveAttribute(
          'data-state',
          'ready',
          { timeout: 30_000 },
        );
        expect(
          await normal.app.evaluate(() =>
            (globalThis as unknown as Hooked).__officemeshTest.windowVisible(),
          ),
        ).toBe(true);
      } finally {
        await normal.close();
      }
    } finally {
      root.dispose();
    }
  });

  test('an installer that Windows will not run does not leave the app closed: it starts again and remembers', async () => {
    test.setTimeout(150_000);
    const root = tempDataRoot();
    const folder = mkdtempSync(join(tmpdir(), 'intercom-e2e-installer-'));
    const port = randomPort();
    const marker = join(root.path, 'installer-blocked');
    try {
      const installer = standInInstaller(
        folder,
        join(root.path, 'alice', 'officemesh.db'),
        join(folder, 'report.txt'),
      );
      await prepare(root.path, port, folder);
      const run = await launchApp('alice', root.path, lanArgs(port));
      await expect(run.window.getByTestId('update-required')).toBeVisible({ timeout: 30_000 });
      // The check has passed; now the file is one Windows cannot start, which is what node reports
      // as `spawn UNKNOWN` (the same error as when Smart App Control refuses an installer).
      writeFileSync(installer, 'MZ this is not a program');
      await run.window.getByTestId('update-required-install').click();
      await run.app.waitForEvent('close', { timeout: 30_000 }).catch(() => {});
      // The app is running again, by itself (no test is attached to this one): its core was told
      // which installer was refused, and wrote it down.
      const db = join(root.path, 'alice', 'officemesh.db');
      let remembered = '';
      await until('the app to start again and remember the refusal', 60_000, () => {
        try {
          const d = new DatabaseSync(db, { readOnly: true });
          try {
            const row = d
              .prepare("SELECT value FROM settings WHERE key = 'updates.installerBlocked'")
              .get() as { value: string } | undefined;
            remembered = row?.value ?? '';
          } finally {
            d.close();
          }
        } catch {
          // the new app has the database open: try again
        }
        return remembered !== '';
      });
      // (Whether Smart App Control is on depends on the PC the test runs on.)
      expect(JSON.parse(remembered)).toMatchObject({ version: '9.0.0' });
      // Used up: the next start is an ordinary one.
      expect(existsSync(marker)).toBe(false);
    } finally {
      // The app that started itself is not under the test's control: stop it before the profile goes.
      // (Not this PowerShell itself, whose own command line names the folder too.)
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${root.path.replaceAll("'", "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
          ],
          { stdio: 'ignore' },
        );
      } catch {
        // nothing left to stop
      }
      await new Promise((r) => setTimeout(r, 1_500));
      root.dispose();
    }
  });

  test('a message that is typed and not sent keeps the app from restarting for an update, until it is sent or cleared', async () => {
    test.setTimeout(120_000);
    const roots = [tempDataRoot(), tempDataRoot()];
    const port = randomPort();
    const apps = await Promise.all(
      ['alice', 'bob'].map((n, i) => launchApp(n, roots[i]!.path, lanArgs(port))),
    );
    try {
      const ids: string[] = [];
      for (const app of apps) {
        const id = app.window.getByTestId('user-id');
        await expect(id).toHaveText(/^[a-z2-7]{32}$/);
        ids.push((await id.textContent())!);
      }
      const a = apps[0]!.window;
      await expectPerson(a, ids[1]).toHaveAttribute('data-online', 'true', { timeout: 20_000 });
      await clickPerson(a, ids[1]);

      // What the Diagnostics page says about restarting for an update, asked afresh each time.
      const restart = async (page: Page): Promise<string> => {
        await page.getByTestId('me-avatar').click();
        await page.getByTestId('open-settings').click();
        await page.getByTestId('settings-tab-diagnostics').click();
        await page.getByTestId('diagnostics-show').click();
        const text = (await page.getByTestId('diagnostics').textContent())!;
        await page.keyboard.press('Escape');
        return /A new version would be installed now: ([^\n]*)/.exec(text)![1]!;
      };

      // Nothing typed: not "something typed" (it is "yes" if this PC has been left alone for 5
      // minutes, otherwise the user is at the app).
      expect(await restart(a)).not.toContain('typed');

      await a.getByTestId('composer').click();
      await a.keyboard.type('half a message that is not sent');
      // The window says so at once; the page reads what the core has been told.
      await expect
        .poll(() => restart(a), { timeout: 15_000 })
        .toContain('something typed is not sent');

      // Cleared: no longer in the way.
      await a.getByTestId('composer').click();
      await a.keyboard.press('Control+A');
      await a.keyboard.press('Delete');
      await expect.poll(async () => await restart(a), { timeout: 15_000 }).not.toContain('typed');

      // Typed again and sent: no longer in the way either.
      await a.getByTestId('composer').click();
      await a.keyboard.type('sent now');
      await expect
        .poll(() => restart(a), { timeout: 15_000 })
        .toContain('something typed is not sent');
      await a.getByTestId('composer').click();
      await a.keyboard.press('Enter');
      await expect.poll(async () => await restart(a), { timeout: 15_000 }).not.toContain('typed');
    } finally {
      await Promise.allSettled(apps.map((x) => x.close()));
      roots.forEach((r) => r.dispose());
    }
  });
});

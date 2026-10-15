import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import {
  clickPerson,
  expectPerson,
  lanArgs,
  launchApp,
  randomPort,
  tempDataRoot,
  type RunningApp,
} from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;
const SHOTS = 'test-results/screens';

/** Two apps on a private loopback LAN; by default with a stand-in for the sharing helper. */
async function pair(args = ['--fake-remote-assist']) {
  const roots = [tempDataRoot(), tempDataRoot()];
  const port = randomPort();
  const apps = await Promise.all(
    ['alice', 'bob'].map((n, i) => launchApp(n, roots[i]!.path, [...lanArgs(port), ...args])),
  );
  const ids: string[] = [];
  for (const app of apps) {
    await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
    ids.push((await app.window.getByTestId('user-id').textContent())!);
  }
  await expectPerson(apps[0]!.window, ids[1]).toHaveAttribute('data-online', 'true', {
    timeout: 20_000,
  });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps: apps as [RunningApp, RunningApp], ids, close };
}

const toasts = (a: RunningApp) =>
  a.app.evaluate(() =>
    (
      globalThis as unknown as { __officemeshTest: { toasts(): Array<{ title: string }> } }
    ).__officemeshTest.toasts(),
  );

test.describe('M6.18 remote help', () => {
  test('ask for help: the colleague is told, connects, both see it open, and either can end it', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      await clickPerson(a, ids[1]);
      await a.getByTestId('assist-menu').click();
      await a.getByTestId('assist-help-me').click();
      const mine = a.getByTestId('assist-banner');
      await expect(mine).toHaveAttribute('data-state', 'asking');
      await expect(a.getByTestId('assist-menu')).toBeDisabled();

      // Bob is told, wherever he is in the app, and by a notification.
      const his = b.getByTestId('assist-banner');
      await expect(his).toHaveAttribute('data-state', 'asked');
      await expect(his).toContainText('is asking for your help');
      // Both test PCs use the same Windows name, so Bob's PC sees Alice as a new device: warned.
      await expect(his).toContainText('Check their safety phrase');
      await expect
        .poll(async () => (await toasts(bob)).map((t) => t.title).join('|'))
        .toContain('is asking for your help');
      await b.screenshot({ path: `${SHOTS}/e2e-assist-asked.png` });

      await his.getByTestId('assist-accept').click();
      await expect(his).toHaveAttribute('data-state', 'open');
      await expect(his).toHaveAttribute('data-role', 'viewer');
      await expect(mine).toHaveAttribute('data-state', 'open');
      await expect(mine).toHaveAttribute('data-role', 'sharer');
      await a.screenshot({ path: `${SHOTS}/e2e-assist-open.png` });

      // Bob ends it: both banners say so; Alice can dismiss hers and ask again.
      await his.getByTestId('assist-end').click();
      await expect(mine).toHaveAttribute('data-state', 'ended');
      await expect(mine).toHaveAttribute('data-reason', 'cancelled');
      await expect(mine).toContainText('ended remote help');
      await mine.getByTestId('assist-dismiss').click();
      await expect(a.getByTestId('assist-banner')).toHaveCount(0);
      await expect(a.getByTestId('assist-menu')).toBeEnabled();

      // The other way round, declined.
      await a.getByTestId('assist-menu').click();
      await a.getByTestId('assist-let-me-in').click();
      const second = b.getByTestId('assist-banner').filter({ hasText: 'wants to connect' });
      await expect(second).toHaveAttribute('data-state', 'asked');
      await expect(second).toHaveAttribute('data-role', 'sharer');
      await second.getByTestId('assist-decline').click();
      await expect(a.getByTestId('assist-banner')).toHaveAttribute('data-reason', 'declined');
    } finally {
      await close();
    }
  });
  test('with the real helper: the windows open, connect, and end from InterCom', async () => {
    // Starts the real sharing and viewing helpers on this PC, so it needs a desktop (windows
    // open for a few seconds). The sharing side is view-only: this PC cannot control itself.
    test.skip(process.platform !== 'win32', 'the sharing helper is Windows only');
    test.setTimeout(120_000);
    process.env['INTERCOM_ASSIST_CONTROL'] = 'view';
    const helpers = () =>
      execFileSync('tasklist', ['/FI', 'IMAGENAME eq intercom-assist.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter((l) => l.includes('intercom-assist.exe')).length;
    const { apps, ids, close } = await pair([]);
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      expect(helpers()).toBe(0);
      await clickPerson(a, ids[1]);
      await a.getByTestId('assist-menu').click();
      await a.getByTestId('assist-help-me').click();
      const his = b.getByTestId('assist-banner');
      await expect(his).toHaveAttribute('data-state', 'asked');
      expect(helpers()).toBe(0);
      await his.getByTestId('assist-accept').click();
      // Both banners say it is open once the helpers are up, and each PC runs one helper.
      const mine = a.getByTestId('assist-banner');
      await expect(his).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
      await expect(mine).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
      await expect.poll(helpers, { timeout: 15_000 }).toBe(2);
      // The viewer says it connected, and stays up (nothing ended on its own).
      await a.waitForTimeout(4_000);
      expect(helpers()).toBe(2);
      await expect(his).toHaveAttribute('data-state', 'open');
      await a.screenshot({ path: `${SHOTS}/e2e-assist-real-open.png` });

      // The person sharing ends it in InterCom: both helpers go.
      await mine.getByTestId('assist-end').click();
      await expect(his).toHaveAttribute('data-state', 'ended');
      await expect(mine).toHaveAttribute('data-state', 'ended');
      await expect.poll(helpers, { timeout: 15_000 }).toBe(0);

      // The other way round, ended by the viewer's side.
      await mine.getByTestId('assist-dismiss').click();
      await a.getByTestId('assist-menu').click();
      await a.getByTestId('assist-let-me-in').click();
      // B shares this time; the banner is found by its role, as its text changes with its state.
      const second = b.locator('[data-testid="assist-banner"][data-role="sharer"]');
      await expect(second).toHaveAttribute('data-state', 'asked');
      await second.getByTestId('assist-accept').click();
      await expect(second).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
      await expect.poll(helpers, { timeout: 15_000 }).toBe(2);
      await a.getByTestId('assist-end').click();
      await expect(second).toHaveAttribute('data-state', 'ended');
      await expect.poll(helpers, { timeout: 15_000 }).toBe(0);
    } finally {
      delete process.env['INTERCOM_ASSIST_CONTROL'];
      await close();
    }
  });
});

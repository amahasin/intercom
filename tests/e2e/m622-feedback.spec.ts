import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  expectPerson,
  lanArgs,
  launchApp,
  randomPort,
  tempDataRoot,
  type RunningApp,
} from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;
const SHOTS = 'test-results/screens';
const VERSION = (
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../apps/desktop/package.json'), 'utf8'),
  ) as {
    version: string;
  }
).version;

async function pair(args: string[] = ['--fake-media']) {
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
  for (const [i, app] of apps.entries())
    await expectPerson(app.window, ids[1 - i]).toHaveAttribute('data-online', 'true', {
      timeout: 20_000,
    });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps: apps as [RunningApp, RunningApp], ids, close };
}

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} is not on the page`);
  return b;
};

test.describe('M6.22 feedback round', () => {
  test('the list of people scrolls where the pointer takes it, with a colleague selected', async () => {
    test.setTimeout(150_000);
    const root = tempDataRoot();
    const port = randomPort();
    const app = await launchApp('alice', root.path, lanArgs(port));
    const sim: ChildProcess = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, '../../tools/sim/src/cli.ts'),
        '--peers=0',
        '--lite=60',
        '--lan=loopback',
        `--discovery-port=${port}`,
        '--exit-on-stdin-close',
      ],
      { stdio: ['pipe', 'ignore', 'inherit'] },
    );
    try {
      const w = app.window;
      await w.getByTestId('rail-people').click();
      await expect(w.getByTestId('chat-list')).toContainText('60 online', { timeout: 60_000 });
      await w.waitForTimeout(5_000);
      const rows = w.locator('[data-testid^="person-"][data-online]');
      await rows.nth(6).click();
      const list = w.getByTestId('chat-list');
      const top = async () => list.evaluate((el) => el.scrollTop);

      // Down past the selected colleague and back up: every step goes where the wheel says, and
      // nothing pulls it back to the selected row (hover cards used to take the focus and give it
      // back to that row, which scrolled the list to it).
      await w.mouse.move(150, 300);
      const down: number[] = [];
      for (let i = 0; i < 6; i++) {
        await w.mouse.wheel(0, 120);
        await w.waitForTimeout(700);
        down.push(await top());
      }
      for (let i = 1; i < down.length; i++) expect(down[i]!).toBeGreaterThan(down[i - 1]! + 60);
      const up: number[] = [];
      for (let i = 0; i < 6; i++) {
        await w.mouse.wheel(0, -120);
        await w.waitForTimeout(700);
        up.push(await top());
      }
      for (let i = 1; i < up.length; i++) expect(up[i]!).toBeLessThan(up[i - 1]! + 1);

      // With the pointer resting on the selected row (its card open), too.
      await rows.nth(6).hover();
      await w.waitForTimeout(1_200);
      const rest: number[] = [];
      for (let i = 0; i < 6; i++) {
        await w.mouse.wheel(0, 150);
        await w.waitForTimeout(700);
        rest.push(await top());
      }
      for (let i = 1; i < rest.length; i++) expect(rest[i]!).toBeGreaterThan(rest[i - 1]! + 60);
      // Typing focus is not taken by a card either: the search box keeps it.
      await w.getByTestId('people-filter').click();
      await rows.nth(8).hover();
      await w.waitForTimeout(1_200);
      await expect(w.getByTestId('people-filter')).toBeFocused();
    } finally {
      sim.stdin?.end();
      await new Promise((r) => sim.once('exit', r));
      await app.close();
      root.dispose();
    }
  });

  test('away: "last seen" next to the status; the badges keep their own width; the broadcast counts who is online', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      // Alice says where she works and goes away.
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('workplace-office').click();
      await a.keyboard.press('Escape');
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('presence-away').click();
      await a.keyboard.press('Escape');

      await b.getByTestId('rail-people').click();
      await b.getByTestId(`person-${ids[0]}`).click();
      await expect(b.getByTestId('person-presence')).toContainText(/Away · last seen/, {
        timeout: 20_000,
      });
      // The tag is as wide as its words, not as wide as the status note beside it.
      await expect(b.getByTestId('workplace-badge')).toBeVisible({ timeout: 20_000 });
      const badge = await box(b, 'workplace-badge');
      expect(badge.width).toBeLessThan(220);
      await b.screenshot({ path: `${SHOTS}/e2e-away-last-seen.png` });
      // The same words in the list and in the card.
      await expect(b.getByTestId(`person-${ids[0]}`)).toContainText(/Away · last seen/);

      // Back to Available: the plain status again.
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('presence-available').click();
      await expect(b.getByTestId('person-presence')).toHaveText('Available', { timeout: 20_000 });

      // The broadcast channel counts the people who are on the network now, not everyone ever seen.
      await b.getByTestId('rail-chat').click();
      await b.getByTestId('broadcast-row').click();
      await expect(b.getByTestId('header-presence')).toHaveText(
        /^Everyone on the network · 2 online$/,
      );
    } finally {
      await close();
    }
  });

  test('the Updates page shows the installed version and where it stands', async () => {
    test.setTimeout(90_000);
    const { apps, close } = await pair();
    const a = apps[0].window;
    try {
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('open-settings').click();
      await a.getByTestId('settings-tab-updates').click();
      await expect(a.getByTestId('updates-page')).toBeVisible();
      await expect(a.getByTestId('installed-version')).toHaveText(VERSION);
      // Checks are off in a build that is not installed: the page says so, in one place.
      await a
        .getByTestId('github-updates')
        .click({ force: true })
        .catch(() => {});
      await a.getByTestId('check-for-updates').scrollIntoViewIfNeeded();
      await expect(a.getByTestId('update-badge')).toBeVisible();
      await expect(a.getByTestId('update-folder')).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-updates-page.png` });
    } finally {
      await close();
    }
  });
});

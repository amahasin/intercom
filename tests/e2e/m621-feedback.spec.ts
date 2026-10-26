import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
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
const PICTURE = resolve(import.meta.dirname, '../../apps/desktop/build/icon.png');

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

const clipboard = (app: RunningApp) => app.app.evaluate(({ clipboard: c }) => c.readText());

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} is not on the page`);
  return b;
};

test.describe('M6.21 feedback round', () => {
  test('the profile page: two columns of cards that do not push each other; copy buttons work; the picture; home button', async () => {
    test.setTimeout(150_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      // Alice has a long note (a tall card) and a picture.
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('edit-profile').click();
      await a
        .getByTestId('profile-notes-input')
        .fill(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'));
      await a.getByTestId('profile-save').click();
      await expect(a.getByTestId('profile-saved')).toBeVisible();
      await a.getByTestId('settings-close').click();

      await b.getByTestId('rail-people').click();
      await b.getByTestId(`person-${ids[0]}`).click();
      await expect(b.getByTestId('person-notes')).toContainText('line 12', { timeout: 20_000 });

      // Activity is in the left column; Contact, Groups and Identity are in the right one.
      const left = b.getByTestId('person-left');
      const right = b.getByTestId('person-right');
      await expect(left.getByTestId('person-activity')).toBeVisible();
      await expect(left.getByTestId('person-machine')).toBeVisible();
      await expect(left.getByTestId('person-status')).toBeVisible();
      await expect(right.getByTestId('person-contact')).toBeVisible();
      await expect(right.getByTestId('person-groups')).toBeVisible();
      await expect(right.getByTestId('person-identity')).toBeVisible();
      // Side by side, each starting at the top; the tall Contact card does not move the left ones.
      const l = await box(b, 'person-machine');
      const r = await box(b, 'person-contact');
      expect(r.x).toBeGreaterThan(l.x + l.width - 2);
      expect(Math.abs(r.y - l.y)).toBeLessThan(2);
      const act = await box(b, 'person-activity');
      const grp = await box(b, 'person-groups');
      // The left column goes on straight down (Activity right under Status), whatever the right holds.
      const status = await box(b, 'person-status');
      expect(act.y).toBeGreaterThanOrEqual(status.y + status.height);
      expect(act.y - (status.y + status.height)).toBeLessThan(40);
      expect(grp.x).toBeGreaterThan(act.x + act.width - 2);
      await b.screenshot({ path: `${SHOTS}/e2e-profile-columns.png` });

      // The copy buttons put the text on the clipboard.
      await b.getByTestId('person-ip').getByRole('button', { name: /copy/i }).click();
      const ip = (await b.getByTestId('person-ip').textContent())!.trim();
      await expect.poll(() => clipboard(bob)).toBe(ip);
      await b.getByTestId('person-more-menu').click();
      await b.getByTestId('person-copy-id').click();
      await expect.poll(() => clipboard(bob)).toBe(ids[0]);
      // And the one in a message's menu.
      await b.getByTestId('person-chat').click();
      await b.getByTestId('composer').click();
      await b.keyboard.type('copy this please');
      await b.getByTestId('send').click();
      const mine = b.getByTestId('message').filter({ hasText: 'copy this please' });
      await mine.hover();
      await mine.getByTestId('action-more').click();
      await b.getByRole('menuitem', { name: /copy text/i }).click();
      await expect.poll(() => clipboard(bob)).toBe('copy this please');

      // The Home button, before Back and Forward, goes to your own page from anywhere.
      const home = await box(b, 'nav-home');
      const back = await box(b, 'nav-back');
      expect(home.x).toBeLessThan(back.x);
      await expect(b.getByTestId('conversation')).toBeVisible();
      await b.getByTestId('nav-home').click();
      await expect(b.getByTestId('own-page')).toBeVisible();
      await expect(b.getByTestId('conversation')).toHaveCount(0);
      await b.getByTestId('rail-people').click();
      await b.getByTestId('nav-home').click();
      await expect(b.getByTestId('own-page')).toBeVisible();
    } finally {
      await close();
    }
  });

  test('the welcome page: Edit profile is in the top right corner of the main card; two columns', async () => {
    test.setTimeout(90_000);
    const { apps, close } = await pair();
    const a = apps[0].window;
    try {
      await expect(a.getByTestId('own-page')).toBeVisible();
      const edit = await box(a, 'own-edit-profile');
      const hero = await a
        .getByTestId('welcome-avatar')
        .locator('xpath=ancestor::div[contains(@style, "position: relative")][1]')
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
      // Inside the card, near its top and its right edge.
      expect(edit.y).toBeLessThan(hero.y + 40);
      expect(edit.x + edit.width).toBeGreaterThan(hero.x + hero.w - 40);
      expect(edit.x + edit.width).toBeLessThanOrEqual(hero.x + hero.w);
      const left = await box(a, 'own-left');
      const right = await box(a, 'own-right');
      expect(right.x).toBeGreaterThan(left.x + left.width - 2);
      await a.getByTestId('own-edit-profile').click();
      await expect(a.getByTestId('profile-name-input')).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-own-page-top-right.png` });
    } finally {
      await close();
    }
  });

  test('working from home or the office: chosen from the menu or Settings, seen on the page and card', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      await b.getByTestId('rail-people').click();
      await b.getByTestId(`person-${ids[0]}`).click();
      // Not said yet.
      await expect(b.getByTestId('person-workplace')).toContainText('Unknown');
      await expect(b.getByTestId('workplace-badge')).toHaveCount(0);

      // From the picture menu.
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('workplace-home').click();
      await expect(b.getByTestId('workplace-badge')).toHaveAttribute('data-workplace', 'home', {
        timeout: 20_000,
      });
      await expect(b.getByTestId('workplace-badge')).toContainText('Working from home');
      await expect(b.getByTestId('person-workplace')).toContainText('Working from home');
      await expect(a.getByTestId('own-workplace')).toContainText('Working from home');
      await b.mouse.move(2, 2);
      await b.getByTestId(`person-${ids[0]}`).locator('.fui-Avatar').first().hover();
      await expect(b.getByTestId('card-workplace')).toContainText('Working from home', {
        timeout: 5_000,
      });
      await b.screenshot({ path: `${SHOTS}/e2e-workplace-home.png` });

      // From Settings > Profile: the office.
      await a.keyboard.press('Escape');
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('edit-profile').click();
      await a.getByTestId('profile-workplace-office').click();
      await a.getByTestId('profile-save').click();
      await expect(a.getByTestId('profile-saved')).toBeVisible();
      await expect(b.getByTestId('workplace-badge')).toHaveAttribute('data-workplace', 'office', {
        timeout: 20_000,
      });
      await expect(b.getByTestId('workplace-badge')).toContainText('In the office');
    } finally {
      await close();
    }
  });

  test('the broadcast channel: above the chat list, everyone is in it', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      // Just above the list of chats, on both PCs.
      await expect(a.getByTestId('broadcast-row')).toBeVisible();
      const row = await box(a, 'broadcast-row');
      const list = await box(a, 'chat-list');
      expect(row.y + row.height).toBeLessThanOrEqual(list.y + 2);
      await a.getByTestId('broadcast-row').click();
      await expect(a.getByTestId('conversation')).toBeVisible();
      await expect(a.getByTestId('broadcast-avatar')).toBeVisible();
      await expect(a.getByTestId('header-presence')).toContainText('Everyone on the network');
      // A channel, not a call: no call buttons, no members menu.
      await expect(a.getByTestId('assist-menu')).toHaveCount(0);
      await a.getByTestId('composer').click();
      await a.keyboard.type('The coffee machine is fixed');
      await a.getByTestId('send').click();

      // Bob sees it on his row, opens it, replies; Alice sees the reply there.
      await expect(b.getByTestId('broadcast-unread')).toBeVisible({ timeout: 20_000 });
      await expect(b.getByTestId('broadcast-row')).toContainText('The coffee machine is fixed');
      await b.getByTestId('broadcast-row').click();
      await expect(
        b.getByTestId('message').filter({ hasText: 'The coffee machine is fixed' }),
      ).toBeVisible();
      await b.getByTestId('composer').click();
      await b.keyboard.type('Thank you!');
      await b.getByTestId('send').click();
      await expect(a.getByTestId('message').filter({ hasText: 'Thank you!' })).toBeVisible({
        timeout: 20_000,
      });
      await a.screenshot({ path: `${SHOTS}/e2e-broadcast.png` });

      // It is not one of the chats below, and nothing leaked into their direct chat.
      await expect(a.getByTestId(`conv-${ids[1]}`)).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('the Files page: search and filter what has been shared', async () => {
    test.setTimeout(150_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      await clickPerson(a, ids[1]);
      await a.getByTestId('file-input').setInputFiles(PICTURE);
      await a.getByTestId('send').click();
      await expect(a.getByTestId('attachments')).toHaveCount(0);
      await a.getByTestId('composer').click();
      await a.getByTestId('file-input').setInputFiles({
        name: 'budget-2026.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('a,b\n1,2\n'),
      });
      await a.getByTestId('send').click();
      await expect(a.getByTestId('attachments')).toHaveCount(0);

      await a.getByTestId('rail-files').click();
      await expect(a.getByTestId('files-toolbar')).toBeVisible();
      await expect(a.getByTestId('file-row')).toHaveCount(2, { timeout: 20_000 });
      await expect(a.getByTestId('files-count')).toContainText('2 files');

      // Search by name.
      await a.getByTestId('files-search').fill('budget');
      await expect(a.getByTestId('file-row')).toHaveCount(1);
      await expect(a.getByTestId('file-row')).toContainText('budget-2026.csv');
      await expect(a.getByTestId('files-count')).toContainText('1 of 2');
      await a.getByTestId('files-search').fill('zzz');
      await expect(a.getByTestId('files-no-match')).toBeVisible();
      await a.getByTestId('files-clear').click();
      await expect(a.getByTestId('file-row')).toHaveCount(2);

      // Filter by type.
      await a.getByTestId('files-type').selectOption('pictures');
      await expect(a.getByTestId('file-row')).toHaveCount(1);
      await expect(a.getByTestId('file-row')).toContainText('icon.png');
      await a.getByTestId('files-type').selectOption('documents');
      await expect(a.getByTestId('file-row')).toHaveCount(1);
      await expect(a.getByTestId('file-row')).toContainText('budget-2026.csv');
      await a.getByTestId('files-type').selectOption('archives');
      await expect(a.getByTestId('files-no-match')).toBeVisible();
      await a.getByTestId('files-clear').click();

      // Search by who shared it, and the "shared by" filter (Bob has not shared anything).
      await a.getByTestId('files-from').selectOption('me');
      await expect(a.getByTestId('file-row')).toHaveCount(2);
      await a.getByTestId('files-clear').click();
      await b.getByTestId('rail-files').click();
      await expect(b.getByTestId('file-row')).toHaveCount(2, { timeout: 20_000 });
      await b.getByTestId('files-from').selectOption('me');
      await expect(b.getByTestId('files-no-match')).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-files-filter.png` });
    } finally {
      await close();
    }
  });

  test('the Calls page: both panes can be resized', async () => {
    test.setTimeout(90_000);
    const { apps, close } = await pair();
    const a = apps[0].window;
    try {
      await a.getByTestId('rail-calls').click();
      await expect(a.getByTestId('calls-view')).toBeVisible();
      const drag = async (testId: string, dx: number) => {
        const h = await box(a, testId);
        const x = h.x + h.width / 2;
        const y = h.y + h.height / 2;
        await a.mouse.move(x, y);
        await a.mouse.down();
        await a.mouse.move(x + dx, y, { steps: 6 });
        await a.mouse.up();
      };
      // The list on the left.
      const list0 = (await box(a, 'list-pane')).width;
      await drag('list-resize', 80);
      expect((await box(a, 'list-pane')).width).toBeGreaterThan(list0 + 60);
      await drag('list-resize', -80);
      // The details on the right: dragging its edge to the left widens it.
      const d0 = (await box(a, 'call-details')).width;
      await drag('calls-details-resize', -90);
      expect((await box(a, 'call-details')).width).toBeGreaterThan(d0 + 70);
      await drag('calls-details-resize', 200);
      expect((await box(a, 'call-details')).width).toBeLessThan(d0 + 10);
      // Double click: back to the usual width.
      await a.getByTestId('calls-details-resize').dblclick();
      expect(Math.abs((await box(a, 'call-details')).width - 360)).toBeLessThan(2);
    } finally {
      await close();
    }
  });

  test('banners that only inform go by themselves; the ones that ask for something stay', async () => {
    test.setTimeout(150_000);
    const { apps, ids, close } = await pair(['--fake-media', '--fake-remote-assist']);
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      await clickPerson(a, ids[1]);
      await a.getByTestId('assist-menu').click();
      await a.getByTestId('assist-help-me').click();
      // Asking: Bob must answer, so it stays until he does.
      const his = b.getByTestId('assist-banner');
      await expect(his).toHaveAttribute('data-state', 'asked', { timeout: 20_000 });
      await b.waitForTimeout(12_000);
      await expect(his).toHaveAttribute('data-state', 'asked');
      await his.getByTestId('assist-accept').click();
      await expect(a.getByTestId('assist-banner')).toHaveAttribute('data-state', 'open', {
        timeout: 20_000,
      });
      // While it goes on it stays too.
      await a.waitForTimeout(12_000);
      await expect(a.getByTestId('assist-banner')).toHaveAttribute('data-state', 'open');
      // Ended: only says so, and is gone after a few seconds without anyone dismissing it.
      await his.getByTestId('assist-end').click();
      await expect(a.getByTestId('assist-banner')).toHaveAttribute('data-state', 'ended', {
        timeout: 20_000,
      });
      await expect(a.getByTestId('assist-banner')).toHaveCount(0, { timeout: 20_000 });
      await expect(b.getByTestId('assist-banner')).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await close();
    }
  });
});

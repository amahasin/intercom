import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
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

/** Apps on a private loopback LAN, each knowing the others; `extra` gives each its own switches. */
async function office(names: string[], extra: string[][] = []) {
  const roots = names.map(() => tempDataRoot());
  const port = randomPort();
  const apps = await Promise.all(
    names.map((n, i) => launchApp(n, roots[i]!.path, [...lanArgs(port), ...(extra[i] ?? [])])),
  );
  const ids: string[] = [];
  for (const app of apps) {
    await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
    ids.push((await app.window.getByTestId('user-id').textContent())!);
  }
  for (const [i, app] of apps.entries())
    for (const [j, id] of ids.entries())
      if (i !== j)
        await expectPerson(app.window, id).toHaveAttribute('data-online', 'true', {
          timeout: 30_000,
        });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps: apps as RunningApp[], ids, close };
}

test.describe('M6.27 feedback round', () => {
  test('the day someone joined the company: set in the profile, seen with how long on the page, the card and their own page', async () => {
    test.setTimeout(150_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [a, b] = [apps[0]!.window, apps[1]!.window];
    try {
      await b.getByTestId('rail-people').click();
      await b.getByTestId(`person-${ids[0]}`).click();
      await expect(b.getByTestId('person-joined')).toContainText('Unknown');

      await a.getByTestId('me-avatar').click();
      await a.getByTestId('edit-profile').click();
      // A date picker: the day, not a time. Alice joined in 2019.
      await a.getByTestId('profile-joined-input').fill('2019-07-15');
      await a.getByTestId('profile-save').click();
      await expect(a.getByTestId('profile-saved')).toBeVisible();

      await expect(b.getByTestId('person-joined')).toContainText('Jul 15, 2019', {
        timeout: 20_000,
      });
      await expect(b.getByTestId('person-joined').getByTestId('joined-tenure')).toContainText(
        /\d+ years?/,
      );
      await b.screenshot({ path: `${SHOTS}/e2e-joined-company.png` });
      await expect(a.getByTestId('own-joined')).toContainText('Jul 15, 2019');
      await b.mouse.move(2, 2);
      await b.getByTestId(`person-${ids[0]}`).locator('.fui-Avatar').first().hover();
      await expect(b.getByTestId('card-joined')).toContainText('Jul 15, 2019', { timeout: 5_000 });

      // A date that has not come yet is shown as it is, not as a length of time. (The profile
      // window stays open after Save.)
      await a.getByTestId('profile-joined-input').fill('2099-01-01');
      await a.getByTestId('profile-save').click();
      await expect(b.getByTestId('person-joined')).toContainText('Has not started yet', {
        timeout: 20_000,
      });

      // Cleared: unknown again.
      await a.getByTestId('profile-joined-input').fill('');
      await a.getByTestId('profile-save').click();
      await expect(b.getByTestId('person-joined')).toContainText('Unknown', { timeout: 20_000 });
    } finally {
      await close();
    }
  });

  test('Remote Desktop Connection on a colleague’s page: starts the program, and a saved sign-in is used and can be forgotten', async () => {
    test.setTimeout(150_000);
    const dir = mkdtempSync(join(tmpdir(), 'intercom-e2e-rdp-'));
    const report = join(dir, 'rdp.log');
    const lines = () =>
      existsSync(report)
        ? readFileSync(report, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [];
    const { apps, ids, close } = await office(
      ['alice', 'bob'],
      [[`--fake-remote-desktop=${report}`]],
    );
    const a = apps[0]!.window;
    try {
      await a.getByTestId('rail-people').click();
      await a.getByTestId(`person-${ids[1]}`).click();
      await expect(a.getByTestId('rdp-connect')).toBeEnabled({ timeout: 20_000 });
      await expect(a.getByTestId('rdp-connect')).toContainText('Remote Desktop Connection');

      // Nothing saved: the program is started at their address, and nothing else is given to it.
      await a.getByTestId('rdp-connect').click();
      await expect.poll(() => lines().length, { timeout: 10_000 }).toBe(1);
      expect(lines()[0]).toMatchObject({ action: 'connect' });
      expect(lines()[0]!['login']).toBeUndefined();
      expect(String(lines()[0]!['address'])).toMatch(/^[A-Za-z0-9.-]+$/);

      // Save a sign-in for this PC, and connect.
      await a.getByTestId('rdp-signin').click();
      await expect(a.getByTestId('rdp-dialog')).toBeVisible();
      await expect(a.getByTestId('rdp-save-connect')).toBeDisabled();
      await a.getByTestId('rdp-address').fill('192.168.10.100');
      await a.getByTestId('rdp-username').fill('sam-home');
      await a.getByTestId('rdp-password').fill('S3cret pass"word');
      await a.screenshot({ path: `${SHOTS}/e2e-remote-desktop-dialog.png` });
      await a.getByTestId('rdp-save-connect').click();
      await expect(a.getByTestId('rdp-dialog')).toHaveCount(0);
      await expect(a.getByTestId('rdp-signin')).toHaveAttribute('data-saved', 'true');
      await expect.poll(() => lines().length, { timeout: 10_000 }).toBe(2);
      expect(lines()[1]).toMatchObject({
        action: 'connect',
        address: '192.168.10.100',
        login: { username: 'sam-home', password: 'S3cret pass"word' },
      });

      // The button alone now connects with it, without a dialog.
      await a.getByTestId('rdp-connect').click();
      await expect.poll(() => lines().length, { timeout: 10_000 }).toBe(3);
      expect(lines()[2]).toMatchObject({ login: { username: 'sam-home' } });

      // The password is never shown again, and the page does not hold it.
      await a.getByTestId('rdp-signin').click();
      await expect(a.getByTestId('rdp-username')).toHaveValue('sam-home');
      await expect(a.getByTestId('rdp-password')).toHaveValue('');
      await expect(a.getByTestId('rdp-password')).toHaveAttribute('placeholder', /Saved/);
      expect(await a.locator('body').innerText()).not.toContain('S3cret');

      // Forget: the sign-in is gone, and so is Windows' entry for it.
      await a.getByTestId('rdp-forget').click();
      await expect(a.getByTestId('rdp-signin')).toHaveAttribute('data-saved', 'false');
      await expect
        .poll(() => lines().some((l) => l['action'] === 'forget'), { timeout: 10_000 })
        .toBe(true);
      expect(lines().find((l) => l['action'] === 'forget')).toMatchObject({
        address: '192.168.10.100',
      });
      await a.getByTestId('rdp-connect').click();
      await expect.poll(() => lines().length, { timeout: 10_000 }).toBe(5);
      expect(lines()[4]!['login']).toBeUndefined();
    } finally {
      await close();
    }
  });

  test('Details of a message in a group: who has it and who has seen it, with times', async () => {
    test.setTimeout(180_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    const [a, b] = [apps[0]!.window, apps[1]!.window];
    try {
      await a.getByTestId('new-group').click();
      await a.getByTestId(`pick-${ids[1]}`).click();
      await a.getByTestId(`pick-${ids[2]}`).click();
      await a.getByTestId('group-create').click();
      await a.getByTestId('composer').click();
      await a.keyboard.type('Lunch is at one');
      await a.getByTestId('composer').press('Enter');
      const mine = a.getByTestId('message').filter({ hasText: 'Lunch is at one' });
      await expect(mine).toBeVisible();
      await mine.hover();
      await mine.getByTestId('action-more').click();
      await a.getByTestId('action-details').click();
      const dialog = a.getByTestId('message-details');
      await expect(dialog.getByTestId('details-delivered-list')).toContainText(
        'Delivered to 2 of 2',
        {
          timeout: 30_000,
        },
      );
      await expect(
        dialog.getByTestId('details-delivered-list').getByTestId('details-person'),
      ).toHaveCount(2);
      await expect(dialog.getByTestId('details-seen-list')).toContainText('Seen by 0 of 2');

      // Bob opens the group: he moves from "not yet" to the list of who has seen it.
      await b.getByTestId('rail-chat').click();
      await b.getByTestId('chat-list').locator('[data-testid^="conv-"]').first().click();
      await expect(b.getByTestId('message').filter({ hasText: 'Lunch is at one' })).toBeVisible();
      await expect(dialog.getByTestId('details-seen-list')).toContainText('Seen by 1 of 2', {
        timeout: 30_000,
      });
      await expect(
        dialog.getByTestId('details-seen-list').getByTestId('details-person'),
      ).toHaveCount(1);
      await expect(dialog.getByTestId('details-not-yet')).toHaveCount(1);
      await a.screenshot({ path: `${SHOTS}/e2e-message-details-group.png` });
    } finally {
      await close();
    }
  });
});

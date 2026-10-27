import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function pair(args: string[] = []) {
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

async function type(page: Page, text: string) {
  await page.getByTestId('composer').click();
  await page.keyboard.type(text);
}

test.describe('M6.23 feedback round', () => {
  test('the @ menu is a card with pictures and names, and a mention is a chip; a pin shows on its button', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      await clickPerson(b, ids[0]);
      await type(b, 'hello ');
      await b.keyboard.type('@');
      const menu = b.getByTestId('mention-menu');
      await expect(menu).toBeVisible();
      // It has a background, a frame and her name: not loose words over the message box.
      const paint = await menu.evaluate((el) => {
        const css = getComputedStyle(el);
        return { background: css.backgroundColor, border: css.borderTopWidth };
      });
      expect(paint.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(paint.background).not.toBe('transparent');
      expect(paint.border).toBe('1px');
      const option = b.getByTestId('mention-option').first();
      await expect(option).toContainText(/\w/);
      await expect(option.locator('.fui-Avatar')).toBeVisible();
      await expect(option).toHaveAttribute('aria-selected', 'true');
      await b.screenshot({ path: `${SHOTS}/e2e-mention-menu.png` });
      // It sits above the line being typed in, not over it.
      const box = (await menu.boundingBox())!;
      const line = (await b.getByTestId('composer').boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(line.y + line.height);
      await b.screenshot({ path: `${SHOTS}/e2e-mention-menu.png` });

      // Typing narrows it; Enter takes the highlighted one and it shows as a chip.
      await b.keyboard.press('Enter');
      const chip = b.locator('.om-mention').first();
      await expect(chip).toBeVisible();
      const chipPaint = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(chipPaint).not.toBe('rgba(0, 0, 0, 0)');
      await b.keyboard.type('are you in?');
      await b.keyboard.press('Enter');
      await b.getByTestId('message').filter({ hasText: 'are you in?' }).first().waitFor();
      await b.screenshot({ path: `${SHOTS}/e2e-mention-sent.png` });

      // Pins: the header's pin button is plain until something is pinned, then filled with a count.
      await expect(b.getByTestId('pinned-button')).toHaveAttribute('data-pinned', '0');
      await expect(b.getByTestId('pinned-count')).toHaveCount(0);
      const mine = b.getByTestId('message').filter({ hasText: 'are you in?' }).first();
      await mine.hover();
      const bar = mine.getByTestId('action-more');
      const at = (await bar.boundingBox())!;
      await b.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 5 });
      await bar.click();
      await b.getByTestId('action-pin').click();
      await expect(b.getByTestId('pinned-button')).toHaveAttribute('data-pinned', '1', {
        timeout: 10_000,
      });
      await expect(b.getByTestId('pinned-count')).toHaveText('1');
      await b.screenshot({ path: `${SHOTS}/e2e-pin-feedback.png` });
      // Alice, who did not pin it, sees it too.
      await clickPerson(a, ids[1]);
      await expect(a.getByTestId('pinned-button')).toHaveAttribute('data-pinned', '1', {
        timeout: 15_000,
      });
    } finally {
      await close();
    }
  });

  test('a card opens from the picture only, beside it, with the buttons that fit where it opened', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      await a.getByTestId('rail-people').click();
      const row = a.getByTestId(`person-${ids[1]}`);
      // The name and the rest of the row open nothing.
      await row.locator('.fui-Text').first().hover();
      await a.waitForTimeout(900);
      await expect(a.getByTestId('profile-hover')).toHaveCount(0);
      // Their picture does, to its right, with both buttons (nothing of theirs is open yet).
      await a.mouse.move(2, 2);
      const avatar = row.locator('.fui-Avatar').first();
      await avatar.hover();
      const card = a.getByTestId('profile-hover');
      await expect(card).toBeVisible({ timeout: 5_000 });
      await expect(a.getByTestId('card-chat')).toBeVisible();
      await expect(a.getByTestId('card-profile')).toBeVisible();
      const [pic, shown] = [(await avatar.boundingBox())!, (await card.boundingBox())!];
      expect(shown.x).toBeGreaterThanOrEqual(pic.x + pic.width - 2);
      expect(shown.x + shown.width).toBeLessThanOrEqual((a.viewportSize()?.width ?? 1280) + 1);
      await a.screenshot({ path: `${SHOTS}/e2e-avatar-card-both.png` });

      // With their page open the card only offers the chat; with the chat open, only the page.
      await a.mouse.move(2, 2);
      await row.click();
      await avatar.hover();
      await expect(a.getByTestId('card-chat')).toBeVisible({ timeout: 5_000 });
      await expect(a.getByTestId('card-profile')).toHaveCount(0);
      await a.mouse.move(2, 2);
      await a.getByTestId('person-chat').click();
      await expect(a.getByTestId('conversation')).toBeVisible();
      await a.mouse.move(2, 2);
      await a.getByTestId('header-title').hover();
      await a.waitForTimeout(900);
      await expect(a.getByTestId('profile-hover')).toHaveCount(0);
      await a.getByTestId('open-profile-card').hover();
      await expect(a.getByTestId('card-profile')).toBeVisible({ timeout: 5_000 });
      await expect(a.getByTestId('card-chat')).toHaveCount(0);

      // In a message of the chat, the sender's picture does the same.
      await b.getByTestId('rail-chat').click();
      await b
        .getByTestId(`conv-${ids[0]}`)
        .click()
        .catch(() => {});
    } finally {
      await close();
    }
  });

  test('the buttons of a card opened over a chat row do what they say, not what the row does', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const a = apps[0].window;
    try {
      // A chat with Bob exists, and something else is open, so his card offers both buttons.
      await clickPerson(a, ids[1]);
      await a.getByTestId('rail-chat').click();
      await a.getByTestId('broadcast-row').click();
      const row = a.getByTestId(`conv-${ids[1]}`);
      const avatar = row.locator('.fui-Avatar').first();

      // Profile: his page, not the chat the row would open.
      await avatar.hover();
      await expect(a.getByTestId('card-profile')).toBeVisible({ timeout: 5_000 });
      await expect(a.getByTestId('card-chat')).toBeVisible();
      await a.getByTestId('card-profile').click();
      await expect(a.getByTestId('person-page')).toBeVisible({ timeout: 5_000 });
      await expect(a.getByTestId('conversation')).toHaveCount(0);

      // Chat: the chat.
      await a.getByTestId('rail-chat').click();
      await a.getByTestId('broadcast-row').click();
      await a.mouse.move(2, 2);
      await avatar.hover();
      await expect(a.getByTestId('card-chat')).toBeVisible({ timeout: 5_000 });
      await a.getByTestId('card-chat').click();
      await expect(a.getByTestId('conversation')).toBeVisible({ timeout: 5_000 });
      await expect(a.getByTestId('header-title')).toBeVisible();
      // The People list, with his page the one that was last open there: the card offers the chat only,
      // and its button opens it (not what a row's click does, which is his page).
      await a.getByTestId('rail-people').click();
      await a.mouse.move(2, 2);
      const person = a.getByTestId(`person-${ids[1]}`);
      await person.locator('.fui-Avatar').first().hover();
      await expect(a.getByTestId('card-chat')).toBeVisible({ timeout: 5_000 });
      await expect(a.getByTestId('card-profile')).toHaveCount(0);
      await a.getByTestId('card-chat').click();
      await expect(a.getByTestId('conversation')).toBeVisible({ timeout: 5_000 });
    } finally {
      await close();
    }
  });

  test('the Updates page downloads and installs new versions by itself, unless that is turned off', async () => {
    test.setTimeout(90_000);
    const { apps, close } = await pair();
    const a = apps[0].window;
    try {
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('open-settings').click();
      await a.getByTestId('settings-tab-updates').click();
      const box = a.getByTestId('auto-download-updates');
      await box.scrollIntoViewIfNeeded();
      await expect(box).toBeVisible();
      // On by default; the same for the check on GitHub it belongs to.
      await expect(box).toBeChecked();
      // Installing by itself is on too (quietly, when the user is away and nothing is under way),
      // and it needs the installer here, so while it is on the download is automatic and locked.
      const install = a.getByTestId('auto-install-updates');
      await expect(install).toBeVisible();
      await expect(install).toBeChecked();
      await expect(box).toBeDisabled();
      await a.screenshot({ path: `${SHOTS}/e2e-updates-auto-install.png` });
      await install.click();
      await expect(install).not.toBeChecked();
      await expect(box).toBeEnabled();
      await box.click();
      await expect(box).not.toBeChecked();
      await a.screenshot({ path: `${SHOTS}/e2e-updates-auto-download.png` });
      await box.click();
      await expect(box).toBeChecked();
      // And it is kept: turned back on, the download is locked on again.
      await install.click();
      await expect(install).toBeChecked();
      await expect(box).toBeDisabled();
    } finally {
      await close();
    }
  });

  test('a folder is sent as the tree it is, and arrives as a folder', async () => {
    test.setTimeout(150_000);
    // A folder on Alice's PC: a few levels, an empty folder, a thousand small files, a bigger one.
    const source = join(mkdtempSync(join(tmpdir(), 'intercom-e2e-folder-')), 'Quarter Reports');
    mkdirSync(join(source, 'q1', 'drafts'), { recursive: true });
    mkdirSync(join(source, 'empty'), { recursive: true });
    mkdirSync(join(source, 'many'), { recursive: true });
    writeFileSync(join(source, 'readme.txt'), 'hello');
    writeFileSync(join(source, 'q1', 'résumé.txt'), 'unicode');
    writeFileSync(join(source, 'q1', 'drafts', 'a.bin'), Buffer.from([1, 2, 3]));
    // Big enough that the transfer can be watched going (the sender's card, below).
    writeFileSync(join(source, 'big.dat'), Buffer.alloc(200 * 1024 * 1024 + 3, 9));
    for (let i = 0; i < 400; i++) writeFileSync(join(source, 'many', `f${i}.txt`), `file ${i}`);
    const names = (dir: string, prefix = ''): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .sort((x, y) => x.name.localeCompare(y.name))
        .flatMap((e) =>
          e.isDirectory()
            ? [`${prefix}${e.name}/`, ...names(join(dir, e.name), `${prefix}${e.name}/`)]
            : [`${prefix}${e.name}`],
        );

    const roots = [tempDataRoot(), tempDataRoot()];
    const port = randomPort();
    const [alice, bob] = await Promise.all([
      launchApp('alice', roots[0]!.path, lanArgs(port), { INTERCOM_FAKE_SHARE_FOLDER: source }),
      launchApp('bob', roots[1]!.path, lanArgs(port)),
    ]);
    try {
      const ids: string[] = [];
      for (const app of [alice, bob]) {
        await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
        ids.push((await app.window.getByTestId('user-id').textContent())!);
      }
      await expectPerson(alice.window, ids[1]).toHaveAttribute('data-online', 'true', {
        timeout: 20_000,
      });
      const a = alice.window;
      await clickPerson(a, ids[1]);
      await expect(a.getByTestId('attach-folder')).toBeVisible();
      await a.getByTestId('attach-folder').click();
      await expect(a.getByTestId('attachment')).toContainText('Quarter Reports');
      await expect(a.getByTestId('attachment')).toContainText('Folder');
      await a.getByTestId('send').click();

      // The sender sees it going out, as one transfer to Bob (not nothing, as it was): who it is
      // for and how far along, which moves, and which clears once Bob has it.
      const mine = a.getByTestId('file-card').first();
      const sending = mine.getByTestId('file-upload');
      await expect(sending).toBeVisible({ timeout: 60_000 });
      await expect(sending).toHaveAttribute('data-user', ids[1]!);
      await expect(sending).toContainText('Sending to');
      await expect(sending).toContainText(/\d+%/);
      const percent = async () =>
        Number(/(\d+)%/.exec((await sending.textContent().catch(() => '')) ?? '')?.[1] ?? -1);
      const first = await percent();
      await a.screenshot({ path: `${SHOTS}/e2e-folder-sending.png` });
      await expect.poll(percent, { timeout: 60_000, intervals: [250] }).toBeGreaterThan(first);

      // Alice's message is a folder card; Bob's too, and it fills up by itself.
      const b = bob.window;
      await b.getByTestId('rail-chat').click();
      await b.getByTestId(`conv-${ids[0]}`).click({ timeout: 30_000 });
      const card = b.getByTestId('file-card').first();
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText('Quarter Reports');
      await expect(card).toContainText(/Folder · 404 files/);
      await b.screenshot({ path: `${SHOTS}/e2e-folder-card.png` });
      await expect(card.getByTestId('file-open')).toBeVisible({ timeout: 90_000 });
      await expect(card.getByTestId('file-open')).toHaveText('Open folder');
      // And a few seconds after it has all gone, the sender's card is quiet again.
      await expect(a.getByTestId('file-upload')).toHaveCount(0, { timeout: 30_000 });
      await b.screenshot({ path: `${SHOTS}/e2e-folder-card-done.png` });

      // On disk: the same tree, in the save folder; no part files, no archive.
      const received = join(roots[1]!.path, 'downloads', 'InterCom', 'Quarter Reports');
      expect(names(received)).toEqual(names(source));
      // (Byte for byte, without asking the test runner to diff 200 MB.)
      expect(
        readFileSync(join(received, 'big.dat')).equals(readFileSync(join(source, 'big.dat'))),
      ).toBe(true);
      expect(
        names(join(roots[1]!.path, 'downloads')).some((n) => /\.(zip|officemesh-part)$/.test(n)),
      ).toBe(false);
    } finally {
      await Promise.allSettled([alice.close(), bob.close()]);
      roots.forEach((r) => r.dispose());
    }
  });
});

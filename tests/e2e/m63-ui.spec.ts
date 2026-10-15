import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  clickPerson,
  expectPerson,
  lanArgs,
  launchApp,
  randomPort,
  tempDataRoot,
  windowWithRole,
  type RunningApp,
} from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;
const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

async function office(names: string[]) {
  const roots = names.map(() => tempDataRoot());
  const port = randomPort();
  const apps = await Promise.all(
    names.map((n, i) => launchApp(n, roots[i]!.path, [...lanArgs(port), '--fake-media'])),
  );
  const ids = await Promise.all(apps.map(userIdOf));
  for (const [i, app] of apps.entries())
    for (const [j, id] of ids.entries())
      if (i !== j)
        await expectPerson(app.window, id).toHaveAttribute('data-online', 'true', {
          timeout: 20_000,
        });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps, ids, close };
}

const isDark = (p: Page) => p.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);

async function send(page: Page, text: string) {
  await page.getByTestId('composer').click();
  await page.keyboard.type(text);
  await page.getByTestId('composer').press('Enter');
}

test.describe('M6.3', () => {
  test('dark mode: a setting that every window follows, and the title bar with it', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    const a = alice.window;
    try {
      // No emulated colour scheme in these tests: the app's own setting decides.
      await a.emulateMedia({ colorScheme: null });
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('open-settings').click();
      await a.getByTestId('settings-tab-general').click();
      await expect(a.getByTestId('setting-theme')).toBeVisible();
      await a.getByTestId('theme-dark').click();
      await expect.poll(() => isDark(a)).toBe(true);
      expect(await alice.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
      await a.screenshot({ path: `${SHOTS}/e2e-dark-settings.png` });
      await a.getByTestId('theme-light').click();
      await expect.poll(() => isDark(a)).toBe(false);
      await a.getByTestId('theme-dark').click();
      await a.getByTestId('settings-close').click();

      // A call window and the ring card, opened later, are dark too.
      await clickPerson(a, ids[1]);
      await a.getByTestId('start-video-call').click();
      const ring = await windowWithRole(bob.app, 'incoming');
      const aCall = await windowWithRole(alice.app, 'call');
      await aCall.emulateMedia({ colorScheme: null });
      await expect.poll(() => isDark(aCall)).toBe(true);
      await ring.getByTestId('call-accept-video').click();
      await expect(aCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });
      await aCall.waitForTimeout(1_000);
      await aCall.screenshot({ path: `${SHOTS}/e2e-dark-call.png` });
      // Bob has not chosen: his windows follow Windows, whatever it is set to.
      const bobDark = await isDark(bob.window);
      expect(bobDark).toBe(
        await bob.window.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
      );
      await aCall.getByTestId('call-hangup').click();
    } finally {
      await close();
    }
  });

  test('delete a chat from the list: confirmation, history gone here, the other side keeps theirs', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    const a = alice.window;
    const b = bob.window;
    try {
      await clickPerson(a, ids[1]);
      await send(a, 'first words');
      await send(a, 'second words');
      await b.getByTestId(`conv-${ids[0]}`).click();
      await expect(b.getByTestId('message')).toHaveCount(2);

      // Cancel does nothing.
      await b.getByTestId(`conv-${ids[0]}`).click({ button: 'right' });
      await b.getByTestId('row-delete').click();
      await expect(b.getByTestId('delete-chat-dialog')).toContainText('removed from this PC');
      await b.screenshot({ path: `${SHOTS}/e2e-delete-chat.png` });
      await b.getByTestId('delete-chat-cancel').click();
      await expect(b.getByTestId('message')).toHaveCount(2);

      // Delete: gone from the list and from this PC.
      await b.getByTestId(`conv-${ids[0]}`).click({ button: 'right' });
      await b.getByTestId('row-delete').click();
      await b.getByTestId('delete-chat-confirm').click();
      await expect(b.getByTestId(`conv-${ids[0]}`)).toHaveCount(0);
      await expect(b.getByTestId('message')).toHaveCount(0);
      // Alice still has hers.
      await expect(a.getByTestId('message')).toHaveCount(2);

      // A new message from Alice starts the chat again, with only that message.
      await send(a, 'third words');
      await expect(b.getByTestId(`conv-${ids[0]}`)).toBeVisible({ timeout: 10_000 });
      await b.getByTestId(`conv-${ids[0]}`).click();
      await expect(b.getByTestId('message')).toHaveCount(1);
      await expect(b.getByTestId('message')).toContainText('third words');
    } finally {
      await close();
    }
  });

  test('toasts and the taskbar are named InterCom: the app has a Start Menu shortcut with its id', async () => {
    test.setTimeout(60_000);
    const { apps, close } = await office(['alice']);
    try {
      const link = await apps[0]!.app.evaluate(({ app, shell }) => {
        const path = `${app.getPath('appData')}/Microsoft/Windows/Start Menu/Programs/InterCom.lnk`;
        try {
          const l = shell.readShortcutLink(path);
          return { appUserModelId: l.appUserModelId, icon: l.icon, description: l.description };
        } catch (err) {
          return { error: String(err) };
        }
      });
      expect(link).toMatchObject({ appUserModelId: 'InterCom.Desktop', description: 'InterCom' });
      expect((link as { icon: string }).icon).toMatch(/icon\.ico$/);
    } finally {
      await close();
    }
  });
  test('themes: Paper out of the box, Harbor and an accent colour, in the main window and a call window opened later', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    const a = alice.window;
    const brand = (p: Page) =>
      p.evaluate(() =>
        getComputedStyle(document.querySelector('.fui-FluentProvider')!)
          .getPropertyValue('--colorBrandBackground')
          .trim()
          .toLowerCase(),
      );
    const look = (p: Page) => p.evaluate(() => document.documentElement.dataset.look);
    try {
      // Out of the box: Paper, with its coral accent (not Fluent's blue).
      await expect.poll(() => look(a)).toBe('paper');
      const coral = await brand(a);
      expect(coral).not.toBe('#0f6cbd');
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('open-settings').click();
      await a.getByTestId('settings-tab-general').click();
      await a.getByTestId('look-harbor').click();
      await expect.poll(() => look(a)).toBe('harbor');
      await expect(a.getByTestId('look-harbor')).toHaveAttribute('aria-checked', 'true');
      await expect(a.getByTestId('accent-default')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => brand(a)).not.toBe(coral);
      const teal = await brand(a);
      expect(teal).not.toBe('#0f6cbd');
      await a.getByTestId('accent-5B4DB7').click();
      await expect(a.getByTestId('accent-5B4DB7')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => brand(a)).not.toBe(teal);
      const violet = await brand(a);
      await a.screenshot({ path: `${SHOTS}/e2e-theme-settings.png` });
      await a.getByTestId('settings-close').click();

      // A window opened afterwards starts in the same look and accent.
      await clickPerson(a, ids[1]);
      await a.getByTestId('start-video-call').click();
      const aCall = await windowWithRole(alice.app, 'call');
      await expect.poll(() => look(aCall)).toBe('harbor');
      await expect.poll(() => brand(aCall)).toBe(violet);
      // Bob has chosen nothing: Paper.
      expect(await look(bob.window)).toBe('paper');
      await aCall.getByTestId('call-hangup').click();

      // Back to the theme's own accent, to Classic (Fluent's own blue) and to Paper.
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('open-settings').click();
      await a.getByTestId('settings-tab-general').click();
      await a.getByTestId('accent-default').click();
      await expect.poll(() => brand(a)).toBe(teal);
      await a.getByTestId('look-classic').click();
      await expect.poll(() => brand(a)).toBe('#0f6cbd');
      await a.getByTestId('look-paper').click();
      await expect.poll(() => brand(a)).toBe(coral);
    } finally {
      await close();
    }
  });
});

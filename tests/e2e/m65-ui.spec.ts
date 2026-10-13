import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
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
mkdirSync(SHOTS, { recursive: true });

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

/** The picture is really there: an <img> from the app's avatar route that decoded. */
async function expectPicture(img: Locator) {
  await expect(img).toBeVisible();
  await expect
    .poll(() =>
      img.evaluate((el: HTMLImageElement) => ({
        from: el.currentSrc.includes('/avatars/'),
        decoded: el.complete && el.naturalWidth > 0,
      })),
    )
    .toEqual({ from: true, decoded: true });
}

test.describe('M6.5', () => {
  test('a profile picture shows on the welcome page, everywhere in the app, and on every colleague’s PC', async () => {
    test.setTimeout(150_000);
    const roots = [tempDataRoot(), tempDataRoot()];
    const port = randomPort();
    const [alice, bob] = (await Promise.all(
      ['alice', 'bob'].map((n, i) =>
        launchApp(n, roots[i]!.path, [...lanArgs(port), '--fake-media']),
      ),
    )) as [RunningApp, RunningApp];
    const a = alice.window;
    const b = bob.window;
    try {
      const [aliceId, bobId] = await Promise.all([userIdOf(alice), userIdOf(bob)]);
      await expectPerson(a, bobId).toHaveAttribute('data-online', 'true', {
        timeout: 20_000,
      });

      // Alice picks a picture in her profile.
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('edit-profile').click();
      await a.getByTestId('avatar-input').setInputFiles(PICTURE);
      await a.getByTestId('settings-close').click();

      // Her own welcome page, title bar and (below) chat show it.
      await expectPicture(a.getByTestId('welcome-avatar').locator('img'));
      await expectPicture(a.getByTestId('me-avatar').locator('img'));

      // Bob's PC learns it: the people list, the chat, messages and the profile card.
      await b.getByTestId('rail-people').click();
      await expectPicture(b.getByTestId(`person-${aliceId}`).locator('img'));
      await clickPerson(b, aliceId);
      await clickPerson(a, bobId);
      await a.getByTestId('composer').click();
      await a.keyboard.type('hello with a picture');
      await a.getByTestId('composer').press('Enter');
      await expect(
        b.getByTestId('message').filter({ hasText: 'hello with a picture' }),
      ).toBeVisible();
      await expectPicture(b.getByTestId('message-avatar').locator('img'));
      await expectPicture(b.getByTestId('conversation-header').locator('img').first());
      await b.getByTestId('open-profile-card').click();
      await expectPicture(b.getByTestId('profile-card').locator('img'));
      await b.screenshot({ path: `${SHOTS}/e2e-avatar-everywhere.png` });
    } finally {
      await Promise.allSettled([alice.close(), bob.close()]);
      roots.forEach((r) => r.dispose());
    }
  });

  test('the title bar: the search box stands out, and the space beside it drags the window', async () => {
    test.setTimeout(60_000);
    const root = tempDataRoot();
    const app = await launchApp('alice', root.path, [...lanArgs(randomPort())]);
    const w = app.window;
    try {
      await userIdOf(app);
      const info = await w.evaluate(() => {
        const region = (el: Element | null) => {
          // The drag region an element is in: the nearest element that says drag or no-drag.
          for (let e = el; e; e = e.parentElement) {
            const v = getComputedStyle(e).getPropertyValue('-webkit-app-region');
            if (v === 'drag' || v === 'no-drag') return v;
          }
          return 'none';
        };
        const input = document.querySelector('[data-testid="search-input"]') as HTMLElement;
        const field = input.closest('.fui-Input') as HTMLElement;
        const box = field.getBoundingClientRect();
        const avatar = (
          document.querySelector('[data-testid="me-avatar"]') as HTMLElement
        ).getBoundingClientRect();
        const bar = document.querySelector('header')!.getBoundingClientRect();
        // A point halfway between the search box and the avatar, in the title bar.
        const x = (box.right + avatar.left) / 2;
        const y = bar.top + bar.height / 2;
        const style = getComputedStyle(field);
        return {
          gapPx: avatar.left - box.right,
          dragBetween: region(document.elementFromPoint(x, y)),
          dragLeft: region(document.elementFromPoint(20, y)),
          avatarRegion: region(document.querySelector('[data-testid="me-avatar"]')),
          searchBg: style.backgroundColor,
          searchBorder: style.borderTopColor,
          barBg: getComputedStyle(document.querySelector('header')!.parentElement!).backgroundColor,
        };
      });
      expect(info.gapPx).toBeGreaterThan(100);
      expect(info.dragBetween).toBe('drag');
      expect(info.dragLeft).toBe('drag');
      expect(info.avatarRegion).toBe('no-drag');
      // Not the same colour as what is behind it.
      expect(info.searchBg).not.toBe(info.barBg);
      expect(info.searchBorder).not.toBe('rgba(0, 0, 0, 0)');
      await w.screenshot({
        path: `${SHOTS}/e2e-titlebar.png`,
        clip: { x: 0, y: 0, width: 1280, height: 56 },
      });
    } finally {
      await app.close();
      root.dispose();
    }
  });
});

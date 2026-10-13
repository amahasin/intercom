import { mkdirSync } from 'node:fs';
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

async function send(page: Page, text: string) {
  await page.getByTestId('composer').click();
  await page.keyboard.type(text);
  await page.getByTestId('composer').press('Enter');
}

test.describe('M6.2 main window', () => {
  test('the app is called InterCom; reactions sit under the bubble; the chat list has favourites, filters and a row menu; back and forward; a Shared tab', async () => {
    test.setTimeout(180_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    const [alice, bob, carol] = apps as [RunningApp, RunningApp, RunningApp];
    const a = alice.window;
    const b = bob.window;
    try {
      // The name, in the title bar and the window.
      await expect(
        a.getByTestId('core-status').locator('header').getByText('InterCom'),
      ).toBeVisible();
      expect(
        await alice.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getTitle(),
        ),
      ).toContain('InterCom');

      await clickPerson(a, ids[1]);
      await send(a, 'Morning, did the figures arrive?');
      await b.getByTestId(`conv-${ids[0]}`).click();
      const incoming = b.getByTestId('message').filter({ hasText: 'did the figures arrive' });
      await expect(incoming).toBeVisible();

      // Bob reacts: the reaction chip is under the bubble, not inside it.
      await incoming.hover();
      await b.getByTestId('react-👍').first().click();
      const chip = b.getByTestId('reaction-👍');
      await expect(chip).toBeVisible();
      const bubbleBox = (await incoming.boundingBox())!;
      const chipBox = (await chip.boundingBox())!;
      expect(chipBox.y).toBeGreaterThanOrEqual(bubbleBox.y + bubbleBox.height - 1);
      // Alice sees it the same way, and hovering names who reacted.
      const mine = a.getByTestId('message').filter({ hasText: 'did the figures arrive' });
      const aChip = a.getByTestId('reaction-👍');
      await expect(aChip).toBeVisible();
      const mineBox = (await mine.boundingBox())!;
      const aChipBox = (await aChip.boundingBox())!;
      expect(aChipBox.y).toBeGreaterThanOrEqual(mineBox.y + mineBox.height - 1);
      await aChip.hover();
      await expect(a.getByText('1 reaction')).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-reaction-outside.png` });

      // Carol writes to Bob as well, so he has two chats.
      await clickPerson(carol.window, ids[1]);
      await send(carol.window, 'Lunch?');
      await expect(b.getByTestId(`conv-${ids[2]}`)).toBeVisible();

      // Favourites, from the row's menu: a Favorites section appears.
      await b.getByTestId(`conv-${ids[2]}`).hover();
      await b.getByTestId(`conv-more-${ids[2]}`).click();
      await b.getByTestId('row-favorite').click();
      await expect(b.getByTestId('section-favorites')).toBeVisible();
      await b.screenshot({ path: `${SHOTS}/e2e-chat-list.png` });
      // A section folds.
      await b.getByTestId('section-favorites').click();
      await expect(b.getByTestId(`conv-${ids[2]}`)).toHaveCount(0);
      await b.getByTestId('section-favorites').click();
      await expect(b.getByTestId(`conv-${ids[2]}`)).toBeVisible();

      // Bob reads Carol's chat, so only a chat he marks by hand is unread.
      await b.getByTestId(`conv-${ids[2]}`).click();
      await expect(b.getByTestId('composer')).toBeVisible();
      // Mark as unread by right-click; the Unread filter then lists only that chat.
      await b.getByTestId(`conv-${ids[0]}`).click({ button: 'right' });
      await b.getByTestId('row-unread').click();
      await expect(b.getByTestId('conv-marked-unread')).toHaveCount(1);
      await b.getByTestId('chat-filter-unread').click();
      await expect(b.locator('[data-testid^="conv-"][data-unread="true"]')).toHaveCount(1);
      await expect(b.getByTestId(`conv-${ids[2]}`)).toHaveCount(0);
      await b.getByTestId('chat-filter-unread').click();
      await expect(b.getByTestId(`conv-${ids[2]}`)).toBeVisible();

      // Mute and hide from the same menu; a hidden chat is gone until it has news.
      await b.getByTestId(`conv-${ids[2]}`).click({ button: 'right' });
      await b.getByTestId('row-hide').click();
      await expect(b.getByTestId(`conv-${ids[2]}`)).toHaveCount(0);
      await send(carol.window, 'Still there?');
      await expect(b.getByTestId(`conv-${ids[2]}`)).toBeVisible({ timeout: 10_000 });

      // Back and forward walk through where Bob has been.
      await b.getByTestId(`conv-${ids[0]}`).click();
      await b.getByTestId('rail-teams').click();
      await expect(b.getByTestId('empty-pane')).toBeVisible();
      await b.getByTestId('nav-back').click();
      await expect(b.getByTestId('conversation')).toBeVisible();
      await b.getByTestId('nav-forward').click();
      await expect(b.getByTestId('empty-pane')).toBeVisible();

      // The Shared tab lists what was shared in the chat.
      await b.getByTestId('rail-chat').click();
      await b.getByTestId(`conv-${ids[0]}`).click();
      await b.getByTestId('tab-shared').click();
      await expect(b.getByTestId('shared-files')).toBeVisible();
      await b.getByTestId('tab-chat').click();
      await expect(b.getByTestId('composer')).toBeVisible();
    } finally {
      await close();
    }
  });
});

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { lanArgs, launchApp, randomPort, tempDataRoot, type RunningApp } from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;

/** Test hooks the main process exposes in development builds (see main.ts). */
interface TestHooks {
  toasts(): Array<{ convId: string; body: string }>;
  replyToToast(convId: string, reply: string): void;
  windowVisible(): boolean;
  hideWindow(): void;
  unread(): number;
}
// Used inside app.evaluate(), which runs in the main process: only the type may be shared.
type Hooked = { __officemeshTest: TestHooks };

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

/** Two PCs: separate data roots, so each has its own file store. */
async function pair() {
  const roots = [tempDataRoot(), tempDataRoot()];
  const port = randomPort();
  const [alice, bob] = await Promise.all([
    launchApp('alice', roots[0]!.path, lanArgs(port)),
    launchApp('bob', roots[1]!.path, lanArgs(port)),
  ]);
  const [aliceId, bobId] = await Promise.all([userIdOf(alice), userIdOf(bob)]);
  await expect(alice.window.getByTestId(`person-${bobId}`)).toHaveAttribute('data-online', 'true', {
    timeout: 10_000,
  });
  await expect(bob.window.getByTestId(`person-${aliceId}`)).toHaveAttribute('data-online', 'true', {
    timeout: 10_000,
  });
  const close = async () => {
    await Promise.allSettled([alice.close(), bob.close()]);
    roots.forEach((r) => r.dispose());
  };
  return { alice, bob, aliceId, bobId, roots, close };
}

async function type(page: Page, text: string) {
  await page.getByTestId('composer').click();
  await page.keyboard.type(text);
}

const message = (page: Page, text: string) => page.getByTestId('message').filter({ hasText: text });

/** The first message containing `text` (a later reply may quote it). */
async function more(page: Page, text: string, action: string) {
  const m = message(page, text).first();
  await m.hover();
  await m.getByTestId('action-more').click();
  await page.getByTestId(action).click();
}

test.describe('M2 rich messaging', () => {
  test('formatting, mentions, reactions, reply, edit, delete, pin, save, typing and Seen', async () => {
    test.setTimeout(90_000);
    const { alice, bob, aliceId, bobId, close } = await pair();
    const a = alice.window;
    const b = bob.window;
    try {
      await a.getByTestId(`person-${bobId}`).click();
      await type(a, 'Hello **team** and `code`');
      await a.keyboard.press('Enter');

      await b.getByTestId(`conv-${aliceId}`).click();
      await expect(message(b, 'Hello').locator('strong', { hasText: 'team' })).toBeVisible();
      await expect(message(b, 'Hello').locator('code', { hasText: 'code' })).toBeVisible();
      // Bob is looking at the chat: his read receipt makes it "Seen" for Alice.
      await expect(a.getByTestId('delivery-status')).toHaveAttribute('data-status', 'read');

      // Typing indicator.
      await type(b, 'thinking');
      await expect(a.getByTestId('typing-indicator')).toContainText('is typing');
      await b.keyboard.press('Control+A');
      await b.keyboard.press('Backspace');

      // A mention picked from the @ menu reaches Alice's Activity.
      await b.keyboard.type('@');
      await expect(b.getByTestId('mention-menu')).toBeVisible();
      await b.keyboard.press('Enter');
      await b.keyboard.type('please review');
      await b.keyboard.press('Enter');
      await expect(
        message(a, 'please review').locator(`[data-mention="${aliceId}"]`),
      ).toBeVisible();

      // Alice reacts, Bob replies, Alice edits, deletes and Bob pins and saves.
      await message(a, 'please review').hover();
      await message(a, 'please review').getByTestId('react-👍').click();
      await expect(message(b, 'please review').getByTestId('reaction-👍')).toContainText('1');

      await message(b, 'Hello').hover();
      await message(b, 'Hello').getByTestId('action-reply').click();
      await b.keyboard.type('Sure thing');
      await b.keyboard.press('Enter');
      await expect(message(a, 'Sure thing').getByTestId('reply-quote')).toContainText('Hello team');

      await more(a, 'Hello team', 'action-edit');
      await a.keyboard.press('Control+A');
      await a.keyboard.type('Hello everyone');
      await a.keyboard.press('Enter');
      await expect(message(b, 'Hello everyone').getByTestId('edited')).toBeVisible();

      await type(a, 'sent by mistake');
      await a.keyboard.press('Enter');
      await more(a, 'sent by mistake', 'action-delete');
      await expect(b.getByText('This message has been deleted.')).toBeVisible();

      await more(b, 'Hello everyone', 'action-pin');
      await a.getByTestId('pinned-button').click();
      await expect(a.getByTestId('pinned-list')).toContainText('Hello everyone');
      await a.keyboard.press('Escape');

      await more(b, 'Sure thing', 'action-save');
      await b.getByTestId('rail-activity').click();
      await b.getByTestId('activity-saved').click();
      await expect(b.getByTestId('saved-item')).toContainText('Sure thing');

      // Alice's Activity: the mention and the reply.
      await expect(a.getByTestId('rail-activity-badge')).toBeVisible();
      await a.getByTestId('rail-activity').click();
      await expect(a.getByTestId('activity-mention')).toBeVisible();
      await expect(a.getByTestId('activity-reply')).toBeVisible();
      await a.getByTestId('activity-mention').click();
      await expect(a.getByTestId('conversation')).toBeVisible();
      await a.screenshot({ path: 'test-results/screens/m2-chat.png' });
    } finally {
      await close();
    }
  });

  test('shares a document on demand and an image inline, and search jumps to a message', async () => {
    test.setTimeout(90_000);
    const { alice, bob, aliceId, bobId, roots, close } = await pair();
    const a = alice.window;
    const b = bob.window;
    try {
      const doc = join(roots[0]!.path, 'Quarterly minutes.txt');
      writeFileSync(doc, 'Minutes of the quarterly meeting\n'.repeat(5_000));
      await a.getByTestId(`person-${bobId}`).click();
      await a.getByTestId('file-input').setInputFiles(doc);
      await a
        .getByTestId('file-input')
        .setInputFiles(resolve(import.meta.dirname, '../../apps/desktop/build/icon.png'));

      await b.getByTestId(`conv-${aliceId}`).click();
      const card = b.getByTestId('file-card').filter({ hasText: 'Quarterly minutes.txt' });
      await expect(card).toHaveAttribute('data-state', 'missing');
      await card.getByTestId('file-download').click();
      await expect(card).toHaveAttribute('data-state', 'complete', { timeout: 15_000 });
      await expect(card.getByTestId('file-open')).toBeVisible();
      // Images under 10 MB arrive by themselves and show inline.
      await expect(b.getByTestId('inline-image')).toHaveAttribute('data-state', 'complete', {
        timeout: 15_000,
      });

      // Search.
      await type(a, 'The zeppelin budget is approved');
      await a.keyboard.press('Enter');
      await b.getByTestId('rail-activity').click();
      await b.getByTestId('search-input').fill('zeppel');
      await expect(b.getByTestId('search-hit')).toHaveCount(1);
      await expect(b.getByTestId('search-hit').locator('mark')).toHaveText('zeppelin');
      await b.getByTestId('search-hit').click();
      await expect(message(b, 'zeppelin budget')).toBeVisible();
      await b.screenshot({ path: 'test-results/screens/m2-files.png' });
    } finally {
      await close();
    }
  });

  test('a reply typed into a toast is sent without opening the window', async () => {
    test.setTimeout(60_000);
    const { alice, bob, aliceId, bobId, close } = await pair();
    try {
      await bob.app.evaluate(() => (globalThis as unknown as Hooked).__officemeshTest.hideWindow());
      await alice.window.getByTestId(`person-${bobId}`).click();
      await type(alice.window, 'Ping via toast');
      await alice.window.keyboard.press('Enter');

      const toasts = () =>
        bob.app.evaluate(
          () =>
            (globalThis as unknown as Hooked).__officemeshTest.toasts() as Array<{
              convId: string;
              body: string;
            }>,
        );
      await expect
        .poll(async () => (await toasts()).map((t) => t.body))
        .toContain('Ping via toast');
      expect(
        await bob.app.evaluate(() => (globalThis as unknown as Hooked).__officemeshTest.unread()),
      ).toBeGreaterThan(0);

      const convId = (await toasts()).find((t) => t.body === 'Ping via toast')!.convId;
      await bob.app.evaluate(
        (_e, args) =>
          (globalThis as unknown as Hooked).__officemeshTest.replyToToast(
            args.convId,
            'Pong from toast',
          ),
        { convId },
      );
      await expect(message(alice.window, 'Pong from toast')).toBeVisible();
      expect(
        await bob.app.evaluate(() =>
          (globalThis as unknown as Hooked).__officemeshTest.windowVisible(),
        ),
      ).toBe(false);
      await expect
        .poll(() =>
          bob.app.evaluate(() => (globalThis as unknown as Hooked).__officemeshTest.unread()),
        )
        .toBe(0);
      void aliceId;
    } finally {
      await close();
    }
  });
});

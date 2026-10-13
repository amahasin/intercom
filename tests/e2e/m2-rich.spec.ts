import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
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
  await expectPerson(alice.window, bobId).toHaveAttribute('data-online', 'true', {
    timeout: 10_000,
  });
  await expectPerson(bob.window, aliceId).toHaveAttribute('data-online', 'true', {
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
  await clickBar(message(page, text).first(), 'action-more');
  await page.getByTestId(action).click();
}

/**
 * Click a button of a message's bar the way a person does: onto the bubble (the bar shows only
 * over it), then up to the bar, which overlaps the bubble's top edge.
 */
async function clickBar(bubble: Locator, testId: string) {
  await bubble.hover();
  const box = (await bubble.getByTestId(testId).boundingBox())!;
  await bubble.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await bubble.getByTestId(testId).click();
}

test.describe('M2 rich messaging', () => {
  test('formatting, mentions, reactions, reply, edit, delete, pin, save, typing and Seen', async () => {
    test.setTimeout(90_000);
    const { alice, bob, aliceId, bobId, close } = await pair();
    const a = alice.window;
    const b = bob.window;
    try {
      await clickPerson(a, bobId);
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
      await clickBar(message(a, 'please review'), 'react-👍');
      // Reactions sit under the bubble, in the same group as it (not inside it).
      await expect(
        message(b, 'please review').locator('xpath=..').getByTestId('reaction-👍'),
      ).toContainText('1');

      await message(b, 'Hello').hover();
      await message(b, 'Hello').getByTestId('action-reply').click();
      await b.keyboard.type('Sure thing');
      await b.keyboard.press('Enter');
      await expect(message(a, 'Sure thing').getByTestId('reply-quote')).toContainText('Hello team');

      await more(a, 'Hello team', 'action-edit');
      await a.keyboard.press('Control+A');
      await a.keyboard.type('Hello everyone');
      await a.keyboard.press('Enter');
      // "Edited" is on the line over the bubble (or under the text when it is not the first of a run).
      await expect(b.getByTestId('edited')).toBeVisible();

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
      await clickPerson(a, bobId);
      // Files wait in the composer until Enter or Send.
      await a.getByTestId('file-input').setInputFiles(doc);
      await a
        .getByTestId('file-input')
        .setInputFiles(resolve(import.meta.dirname, '../../apps/desktop/build/icon.png'));
      await expect(a.getByTestId('attachment')).toHaveCount(2);
      await a.getByTestId('composer').click();
      await a.getByTestId('composer').press('Enter');
      await expect(a.getByTestId('attachment')).toHaveCount(0, { timeout: 30_000 });

      await b.getByTestId(`conv-${aliceId}`).click();
      // A text file shows its first lines in the bubble (and opens in the built-in viewer).
      const card = b.getByTestId('file-card-preview').filter({ hasText: 'Quarterly minutes.txt' });
      // Files arrive by themselves: no Download click.
      await expect(card).toHaveAttribute('data-state', 'complete', { timeout: 15_000 });
      await expect(card.getByTestId('file-preview')).toContainText(
        'Minutes of the quarterly meeting',
      );
      // A picture arrives by itself too, and shows inline.
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
      await clickPerson(alice.window, bobId);
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

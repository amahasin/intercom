import { expect, test } from '@playwright/test';
import { clickPerson, expectPerson, lanArgs, launchApp, randomPort, tempDataRoot } from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;

test.describe('M6.25 feedback', () => {
  test('in a list, Enter makes the next bullet or number (it does not send), an empty one ends the list, and Ctrl+Enter sends', async () => {
    test.setTimeout(120_000);
    const roots = [tempDataRoot(), tempDataRoot()];
    const port = randomPort();
    const apps = await Promise.all(
      ['alice', 'bob'].map((n, i) => launchApp(n, roots[i]!.path, lanArgs(port))),
    );
    try {
      const ids: string[] = [];
      for (const app of apps) {
        const id = app.window.getByTestId('user-id');
        await expect(id).toHaveText(USER_ID);
        ids.push((await id.textContent())!);
      }
      const a = apps[0]!.window;
      await expectPerson(a, ids[1]!).toHaveAttribute('data-online', 'true', { timeout: 20_000 });
      await clickPerson(a, ids[1]!);
      const composer = a.getByTestId('composer');

      // A numbered list: Enter after an item is the next number, and nothing is sent.
      await composer.click();
      await a.getByRole('button', { name: 'Numbered list' }).click();
      await a.keyboard.type('first');
      await a.keyboard.press('Enter');
      await a.keyboard.type('second');
      await a.keyboard.press('Enter');
      await a.keyboard.type('third');
      await expect(composer.locator('ol > li')).toHaveCount(3);
      await expect(a.getByTestId('message').filter({ hasText: 'first' })).toHaveCount(0);
      await a.screenshot({ path: 'test-results/screens/e2e-list-numbers.png' });

      // Enter on an empty item ends the list (the first Enter makes the empty item).
      await a.keyboard.press('Enter');
      await a.keyboard.press('Enter');
      await a.keyboard.type('after the list');
      await expect(composer.locator('ol > li')).toHaveCount(3);
      await expect(composer.locator('p', { hasText: 'after the list' })).toHaveCount(1);
      await composer.click();
      await a.keyboard.press('Control+A');
      await a.keyboard.press('Delete');

      // A bulleted one, sent with Ctrl+Enter: one message with three bullets.
      await a.getByRole('button', { name: 'Bulleted list' }).click();
      await a.keyboard.type('apples');
      await a.keyboard.press('Enter');
      await a.keyboard.type('pears');
      await a.keyboard.press('Enter');
      await a.keyboard.type('plums');
      await expect(composer.locator('ul > li')).toHaveCount(3);
      await a.keyboard.press('Control+Enter');
      const sent = a.getByTestId('message').filter({ hasText: 'plums' });
      await expect(sent).toHaveCount(1);
      await expect(sent.locator('li')).toHaveCount(3);
      await expect(composer).toHaveText('');

      // Outside a list nothing changed: Enter sends.
      await composer.click();
      await a.keyboard.type('plain line');
      await a.keyboard.press('Enter');
      await expect(a.getByTestId('message').filter({ hasText: 'plain line' })).toHaveCount(1);
    } finally {
      await Promise.allSettled(apps.map((x) => x.close()));
      roots.forEach((r) => r.dispose());
    }
  });

  test('Quote and Code block turn only the selected text (or the line the cursor is on) into a block', async () => {
    test.setTimeout(120_000);
    const roots = [tempDataRoot(), tempDataRoot()];
    const port = randomPort();
    const apps = await Promise.all(
      ['alice', 'bob'].map((n, i) => launchApp(n, roots[i]!.path, lanArgs(port))),
    );
    try {
      const ids: string[] = [];
      for (const app of apps) {
        const id = app.window.getByTestId('user-id');
        await expect(id).toHaveText(USER_ID);
        ids.push((await id.textContent())!);
      }
      const a = apps[0]!.window;
      await expectPerson(a, ids[1]!).toHaveAttribute('data-online', 'true', { timeout: 20_000 });
      await clickPerson(a, ids[1]!);
      const composer = a.getByTestId('composer');
      const press = (key: string, times = 1) =>
        a.keyboard.press(key, { delay: 10 }).then(async () => {
          for (let i = 1; i < times; i++) await a.keyboard.press(key);
        });
      const clear = async () => {
        await composer.click();
        await a.keyboard.press('Control+A');
        await a.keyboard.press('Delete');
      };
      /** Three lines of one message (Shift+Enter), the cursor at the end of the last. */
      const threeLines = async () => {
        await clear();
        await a.keyboard.type('line one');
        await a.keyboard.press('Shift+Enter');
        await a.keyboard.type('middle');
        await a.keyboard.press('Shift+Enter');
        await a.keyboard.type('line three');
      };
      const paragraphs = () => composer.locator(':scope > p').allTextContents();

      // A selected line, in the middle of three: only it becomes a code block.
      await threeLines();
      await press('ArrowUp');
      await press('Home');
      await a.keyboard.press('Shift+End');
      await a.getByRole('button', { name: 'Code block' }).click();
      await expect(composer.locator('code')).toHaveCount(1);
      await expect(composer.locator('code')).toHaveText('middle');
      expect(await paragraphs()).toEqual(['line one', 'line three']);
      await a.screenshot({ path: 'test-results/screens/e2e-code-selected-line.png' });

      // Part of a word: the rest of the word stays where it was.
      await clear();
      await a.keyboard.type('abcdef');
      await press('Home');
      await press('ArrowRight', 2);
      await a.keyboard.press('Shift+ArrowRight');
      await a.keyboard.press('Shift+ArrowRight');
      await a.getByRole('button', { name: 'Quote' }).click();
      await expect(composer.locator('blockquote')).toHaveCount(1);
      await expect(composer.locator('blockquote')).toHaveText('cd');
      expect(await paragraphs()).toEqual(['ab', 'ef']);

      // Nothing selected: the line the cursor is on, not the whole message.
      await threeLines();
      await press('ArrowUp');
      await a.getByRole('button', { name: 'Quote' }).click();
      await expect(composer.locator('blockquote')).toHaveText('middle');
      expect(await paragraphs()).toEqual(['line one', 'line three']);

      // Two lines selected: both, and the third stays out.
      await threeLines();
      await press('Control+Home');
      await a.keyboard.press('Shift+ArrowDown');
      await a.keyboard.press('Shift+End');
      await a.getByRole('button', { name: 'Code block' }).click();
      await expect(composer.locator('code')).toHaveCount(1);
      await expect(composer.locator('code')).toContainText('line one');
      await expect(composer.locator('code')).toContainText('middle');
      await expect(composer.locator('code')).not.toContainText('line three');
      expect(await paragraphs()).toEqual(['line three']);

      // The cursor on an empty line: that line becomes the block, the text around it stays.
      await clear();
      await a.keyboard.type('above');
      await a.keyboard.press('Shift+Enter');
      await a.keyboard.press('Shift+Enter');
      await a.keyboard.type('below');
      await press('ArrowUp');
      await a.getByRole('button', { name: 'Quote' }).click();
      await expect(composer.locator('blockquote')).toHaveCount(1);
      expect(await paragraphs()).toEqual(['above', 'below']);

      // Sent, it reads as it was written: the text, the block, the text.
      await threeLines();
      await press('ArrowUp');
      await press('Home');
      await a.keyboard.press('Shift+End');
      await a.getByRole('button', { name: 'Code block' }).click();
      // (In a code block Enter is a new line: Ctrl+Enter sends.)
      await a.keyboard.press('Control+Enter');
      const sent = a.getByTestId('message').filter({ hasText: 'line three' });
      await expect(sent).toHaveCount(1);
      await expect(sent).toContainText('line one');
      await expect(sent.locator('pre')).toHaveText('middle');
      await a.screenshot({ path: 'test-results/screens/e2e-code-sent.png' });

      // The whole message when all of it is selected (as before).
      await clear();
      await a.keyboard.type('all of it');
      await a.keyboard.press('Control+A');
      await a.getByRole('button', { name: 'Code block' }).click();
      await expect(composer.locator('code')).toHaveText('all of it');
      expect(await paragraphs()).toEqual([]);
    } finally {
      await Promise.allSettled(apps.map((x) => x.close()));
      roots.forEach((r) => r.dispose());
    }
  });
});

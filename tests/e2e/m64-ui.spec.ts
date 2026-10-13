import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
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

test.describe('M6.4', () => {
  test('the profile card shows who the person is (the safety phrase is one click away); an offline note lines up; an offline colleague can be removed from the list', async () => {
    test.setTimeout(150_000);
    const roots = [tempDataRoot(), tempDataRoot()];
    const port = randomPort();
    const [alice, bob] = (await Promise.all(
      ['alice', 'bob'].map((n, i) =>
        launchApp(n, roots[i]!.path, [...lanArgs(port), '--fake-media']),
      ),
    )) as [RunningApp, RunningApp];
    const a = alice.window;
    try {
      const [aliceId, bobId] = await Promise.all([userIdOf(alice), userIdOf(bob)]);
      expect(aliceId).not.toBe(bobId);
      await expectPerson(a, bobId).toHaveAttribute('data-online', 'true', {
        timeout: 20_000,
      });
      // Bob has a job title and a status, which the card shows.
      await bob.window.getByTestId('me-avatar').click();
      await bob.window.getByTestId('edit-profile').click();
      await bob.window.getByTestId('profile-name-input').fill('Bob Builder');
      await bob.window.getByTestId('profile-status-input').fill('At the site until 4');
      await bob.window.getByTestId('profile-save').click();
      await expect(bob.window.getByTestId('profile-saved')).toBeVisible();
      await bob.window.getByTestId('settings-close').click();

      await clickPerson(a, bobId);
      await expect(a.getByTestId('conversation-header')).toContainText('Bob Builder');
      await a.getByTestId('open-profile-card').click();
      // A colleague seen for the first time carries a warning, and the card opens the safety
      // phrase up front for them. Accepting settles it; the card is then about the person.
      await expect(a.getByTestId('new-device-warning')).toBeVisible();
      await expect(a.getByTestId('peer-safety-phrase').locator('> *')).toHaveCount(6);
      await a.getByTestId('accept-person').click();
      await a.getByTestId('open-profile-card').click();
      const details = a.getByTestId('profile-details');
      await expect(details).toBeVisible();
      await expect(details).toContainText('At the site until 4');
      await expect(details).toContainText('Known since');
      // The safety phrase is not what the card is about: hidden until asked for.
      await expect(a.getByTestId('peer-safety-phrase')).toHaveCount(0);
      await a.getByTestId('verify-toggle').click();
      await expect(a.getByTestId('peer-safety-phrase').locator('> *')).toHaveCount(6);
      await a.screenshot({ path: `${SHOTS}/e2e-profile-card.png` });
      await a.keyboard.press('Escape');

      // Bob leaves. Alice's note under the chat is one block of text, not an indented first line.
      await bob.close();
      await expect(a.getByTestId('typing-indicator')).toContainText('is offline', {
        timeout: 40_000,
      });
      const note = await a.getByTestId('typing-indicator').evaluate((el) => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = [...range.getClientRects()];
        const firstLeft = Math.min(...lines.map((r) => r.left));
        return {
          display: style.display,
          textLeft: firstLeft,
          boxLeft: box.left,
          lines: lines.length,
        };
      });
      expect(note.display).toBe('block');
      // Every line starts at the same place: the note is a block, and as the chat column now has
      // the same edge for bubbles, composer and note, it has no padding of its own.
      expect(Math.abs(note.textLeft - note.boxLeft)).toBeLessThan(6);
      await a.screenshot({ path: `${SHOTS}/e2e-offline-note.png` });

      // Bob is offline now: he can be taken off the people list; his chat stays.
      await expectPerson(a, bobId).toHaveAttribute('data-online', 'false', {
        timeout: 40_000,
      });
      await clickPerson(a, bobId, { button: 'right' });
      await a.getByTestId('person-remove').click();
      await expectPerson(a, bobId).toHaveCount(0);
      await a.getByTestId('rail-chat').click();
      await expect(a.getByTestId(`conv-${bobId}`)).toBeVisible();
    } finally {
      await Promise.allSettled([alice.close(), bob.close()]);
      roots.forEach((r) => r.dispose());
    }
  });
});

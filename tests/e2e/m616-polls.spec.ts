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

async function pair() {
  const roots = [tempDataRoot(), tempDataRoot()];
  const port = randomPort();
  const apps = await Promise.all(
    ['alice', 'bob'].map((n, i) => launchApp(n, roots[i]!.path, lanArgs(port))),
  );
  const ids: string[] = [];
  for (const app of apps) {
    await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
    ids.push((await app.window.getByTestId('user-id').textContent())!);
  }
  await expectPerson(apps[0]!.window, ids[1]).toHaveAttribute('data-online', 'true', {
    timeout: 20_000,
  });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps: apps as [RunningApp, RunningApp], ids, close };
}

test.describe('M6.16 polls', () => {
  test('a poll with a limit, hidden names, results after voting and a deadline; then a named poll closed by hand', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const [a, b] = [apps[0].window, apps[1].window];
    try {
      await clickPerson(a, ids[1]);
      await a.getByTestId('poll-button').click();
      await a.getByTestId('poll-question').fill('Team lunch?');
      // Enter moves on, and adds an option after the last one.
      await a.getByTestId('poll-option-input-0').fill('Pizza');
      await a.getByTestId('poll-option-input-0').press('Enter');
      await expect(a.getByTestId('poll-option-input-1')).toBeFocused();
      await a.keyboard.type('Sushi');
      await a.keyboard.press('Enter');
      await expect(a.getByTestId('poll-option-input-2')).toBeFocused();
      // The same option twice is caught before posting.
      await a.keyboard.type('pizza');
      await expect(a.getByText('This option is already in the list.')).toBeVisible();
      await expect(a.getByTestId('poll-post')).toBeDisabled();
      await a.getByTestId('poll-option-input-2').fill('Tacos');
      await a.getByTestId('poll-multi').click();
      await a.getByTestId('poll-max-choices').selectOption('2');
      await a.getByTestId('poll-anonymous-switch').click();
      await a.getByTestId('poll-results').selectOption('voted');
      await a.getByTestId('poll-closes').selectOption('hour');
      await a.screenshot({ path: `${SHOTS}/e2e-poll-dialog.png` });
      await a.getByTestId('poll-post').click();

      const mine = a.getByTestId('poll').filter({ hasText: 'Team lunch?' });
      await expect(mine.getByTestId('poll-anonymous')).toBeVisible();
      await expect(mine.getByTestId('poll-status')).toContainText('Closes in');
      await expect(mine).toContainText('Choose up to 2');

      // Bob sees how many voted, not what, until he votes.
      await b.getByTestId(`conv-${ids[0]}`).click();
      const his = b.getByTestId('poll').filter({ hasText: 'Team lunch?' });
      await expect(his.getByTestId('poll-hidden')).toHaveText('Vote to see the results.');
      await expect(his.getByTestId('poll-votes-0')).toHaveCount(0);
      await his.getByTestId('poll-option-0').click();
      await expect(his.getByTestId('poll-option-0')).toHaveAttribute('aria-checked', 'true');
      await his.getByTestId('poll-option-2').click();
      await expect(his.getByTestId('poll-option-2')).toHaveAttribute('aria-checked', 'true');
      // Two is the limit: the third option waits.
      await expect(his.getByTestId('poll-option-1')).toBeDisabled();
      await expect(his.getByTestId('poll-hidden')).toHaveCount(0);
      await expect(his.getByTestId('poll-votes-0')).toHaveAttribute('data-votes', '1');
      // Names hidden: no list of who voted.
      await expect(his.getByTestId('poll-see-votes')).toHaveCount(0);
      await expect(mine.getByTestId('poll-votes-2')).toHaveAttribute('data-votes', '1');
      await expect(mine.getByTestId('poll-voters')).toHaveText('1 person voted');
      await b.screenshot({ path: `${SHOTS}/e2e-poll-card.png` });

      // Withdrawing takes both choices back.
      await his.getByTestId('poll-withdraw').click();
      await expect(mine.getByTestId('poll-voters')).toHaveText('0 people voted');

      // A second poll, with names: Bob votes, Alice sees who, closes it, the winner shows.
      await a.getByTestId('poll-button').click();
      await a.getByTestId('poll-question').fill('Friday or Monday?');
      await a.getByTestId('poll-option-input-0').fill('Friday');
      await a.getByTestId('poll-option-input-1').fill('Monday');
      await a.getByTestId('poll-post').click();
      const second = b.getByTestId('poll').filter({ hasText: 'Friday or Monday?' });
      await second.getByTestId('poll-option-1').click();
      const hers = a.getByTestId('poll').filter({ hasText: 'Friday or Monday?' });
      await expect(hers.getByTestId('poll-votes-1')).toHaveAttribute('data-votes', '1');
      await hers.getByTestId('poll-see-votes').click();
      await expect(a.getByTestId('poll-votes-dialog')).toContainText('Monday · 1 vote');
      await expect(a.getByTestId('poll-voter')).toHaveAttribute('data-user', ids[1]!);
      await a.keyboard.press('Escape');
      await hers.getByTestId('poll-close').click();
      await a.getByTestId('poll-close-confirm').click();
      await expect(second).toHaveAttribute('data-closed', 'true');
      await expect(second.getByTestId('poll-winner-1')).toBeVisible();
      await expect(second.getByTestId('poll-option-0')).toBeDisabled();
    } finally {
      await close();
    }
  });
});

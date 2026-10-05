import { expect, test, type Page } from '@playwright/test';
import { lanArgs, launchApp, randomPort, tempDataRoot, type RunningApp } from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

async function pair() {
  const roots = [tempDataRoot(), tempDataRoot()];
  const port = randomPort();
  const [alice, bob] = await Promise.all([
    launchApp('alice', roots[0]!.path, lanArgs(port)),
    launchApp('bob', roots[1]!.path, lanArgs(port)),
  ]);
  const [aliceId, bobId] = await Promise.all([userIdOf(alice), userIdOf(bob)]);
  for (const [app, other] of [
    [alice, bobId],
    [bob, aliceId],
  ] as const) {
    await expect(app.window.getByTestId(`person-${other}`)).toHaveAttribute('data-online', 'true', {
      timeout: 10_000,
    });
  }
  const close = async () => {
    await Promise.allSettled([alice.close(), bob.close()]);
    roots.forEach((r) => r.dispose());
  };
  return { alice, bob, aliceId, bobId, close };
}

/** Type into a composer (the last one inside `scope`, e.g. a thread's) and send. */
async function send(page: Page, text: string, scope = page.locator('body')) {
  await scope.getByTestId('composer').last().click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.describe('M3 groups, teams and channels', () => {
  test('group chat with a poll; a team with an announcement, a thread and members', async () => {
    test.setTimeout(120_000);
    const { alice, bob, bobId, close } = await pair();
    const a = alice.window;
    const b = bob.window;
    try {
      // --- Group chat
      await a.getByTestId('new-group').click();
      await a.getByTestId('group-title').fill('Lunch crew');
      await a.getByTestId(`pick-${bobId}`).click();
      await a.getByTestId('group-create').click();
      await expect(a.getByTestId('conversation-header')).toContainText('Lunch crew');
      await expect(a.getByTestId('header-presence')).toContainText('2 people');
      await send(a, 'Where shall we eat?');

      await b.getByTestId('chat-list').getByText('Lunch crew').click();
      await expect(
        b.getByTestId('message').filter({ hasText: 'Where shall we eat?' }),
      ).toBeVisible();
      await send(b, 'Noodles!');
      // Each message in a group shows its author (not "You" for someone else's).
      await expect(a.getByTestId('message').filter({ hasText: 'Noodles!' })).not.toContainText(
        'You',
      );

      // A poll in the group: Bob votes, Alice sees the count.
      await a.getByTestId('poll-button').click();
      await a.getByTestId('poll-question').fill('Which day?');
      await a.getByTestId('poll-option-input-0').fill('Thursday');
      await a.getByTestId('poll-option-input-1').fill('Friday');
      await a.getByTestId('poll-post').click();
      const bobPoll = b.getByTestId('poll').filter({ hasText: 'Which day?' });
      await expect(bobPoll).toBeVisible();
      await bobPoll.getByTestId('poll-option-1').click();
      await expect(a.getByTestId('poll').getByTestId('poll-votes-1')).toHaveText('1');
      await a.getByTestId('poll-close').click();
      await expect(bobPoll).toContainText('Poll closed');

      // --- A team with Bob; General appears on both sides.
      await a.getByTestId('rail-teams').click();
      await a.getByTestId('team-create-open').click();
      await a.getByTestId('team-name').fill('Book club');
      await a.getByTestId(`pick-${bobId}`).click();
      await a.getByTestId('team-create').click();
      await expect(a.getByTestId('channel-title')).toHaveText('General');

      // An announcement post.
      await a.getByTestId('announcement-toggle').click();
      await a.getByTestId('announcement-input').fill('First meeting');
      await send(a, 'We start with a short novel.');

      await b.getByTestId('rail-teams').click();
      await b.getByTestId('teams-list').getByText('General').click();
      const post = b.getByTestId('post').filter({ hasText: 'We start with a short novel.' });
      await expect(post.getByTestId('announcement-headline')).toHaveText('First meeting');

      // Bob replies in the thread; Alice sees the reply count and the reply.
      await post.getByTestId('post-reply').click();
      await send(b, 'Count me in', post.getByTestId('thread-composer'));
      await expect(post).toContainText('Count me in');
      const alicePost = a.getByTestId('post').filter({ hasText: 'We start with a short novel.' });
      await expect(alicePost.getByTestId('post-replies')).toHaveText('1 reply');
      await alicePost.getByTestId('post-replies').click();
      await expect(alicePost).toContainText('Count me in');

      // Members tab: two members, Alice is the owner.
      await a.getByTestId('tab-members').click();
      await expect(a.getByTestId('member-row')).toHaveCount(2);
      await expect(a.getByTestId('member-owner')).toHaveCount(1);

      // An owner adds a channel; the member sees it.
      await a.getByTestId('team-more').click();
      await a.getByTestId('team-add-channel').click();
      await a.getByTestId('channel-name').fill('Reviews');
      await a.getByTestId('channel-create').click();
      await expect(a.getByTestId('channel-title')).toHaveText('Reviews');
      await expect(b.getByTestId('teams-list').getByText('Reviews')).toBeVisible();

      // The Files rail lists shared files (none yet).
      await a.getByTestId('rail-files').click();
      await expect(a.getByTestId('files-view')).toBeVisible();
    } finally {
      await close();
    }
  });
});

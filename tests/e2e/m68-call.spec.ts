import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  clickPerson,
  expectPerson,
  lanArgs,
  launchApp,
  randomPort,
  tempDataRoot,
  windowCount,
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

/** The rows of the chat list (conversations, not the people under them). */
const chatRows = (page: Page) =>
  page.locator('button[data-testid^="conv-"]:not([data-testid^="conv-more"])');

const say = async (page: Page, text: string) => {
  await page.getByTestId('composer').click();
  await page.keyboard.type(text);
  await page.getByTestId('composer').press('Enter');
};

/** Alice and Bob talk (audio), then Alice adds Carol; all three are in, each with a call window. */
async function threeWay(apps: RunningApp[], ids: string[]) {
  const [alice, bob, carol] = apps as [RunningApp, RunningApp, RunningApp];
  await clickPerson(alice.window, ids[1]!);
  await expect(alice.window.getByTestId('composer')).toBeVisible();
  await alice.window.getByTestId('start-audio-call').click();
  const ring = await windowWithRole(bob.app, 'incoming');
  await ring.getByTestId('call-accept-audio').click();
  const aCall = await windowWithRole(alice.app, 'call');
  const bCall = await windowWithRole(bob.app, 'call');
  await expect(aCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });

  await aCall.getByTestId('call-more').click();
  await aCall.getByTestId('call-add').click();
  await aCall.getByTestId(`pick-${ids[2]!}`).click();
  await aCall.getByTestId('call-add-confirm').click();
  const ringCarol = await windowWithRole(carol.app, 'incoming', 30_000);
  await ringCarol.getByTestId('call-accept-audio').click();
  const cCall = await windowWithRole(carol.app, 'call');
  for (const w of [aCall, bCall, cCall])
    await expect(w.getByTestId('call-tile')).toHaveCount(3, { timeout: 30_000 });
  return { alice, bob, carol, aCall, bCall, cCall };
}

test.describe('M6.8 call chat', () => {
  test('the call window shows the main chat; a third person swaps it for the call group; leaving takes out one window', async () => {
    test.setTimeout(240_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    const [alice, bob, carol] = apps as [RunningApp, RunningApp, RunningApp];
    try {
      // The direct chat has something in it before the call.
      await clickPerson(alice.window, ids[1]!);
      await expect(alice.window.getByTestId('composer')).toBeVisible();
      await say(alice.window, 'before the call');
      await expect(
        alice.window.getByTestId('message').filter({ hasText: 'before the call' }),
      ).toBeVisible();

      await alice.window.getByTestId('start-audio-call').click();
      const ring = await windowWithRole(bob.app, 'incoming');
      await ring.getByTestId('call-accept-audio').click();
      const aCall = await windowWithRole(alice.app, 'call');
      const bCall = await windowWithRole(bob.app, 'call');
      await expect(aCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });

      // Two people: the call window's chat is the direct chat, drawn by the same component as the
      // main window (its day line, bubbles, typing line and composer, which the old panel lacked).
      await aCall.getByTestId('call-chat').click();
      const pane = aCall.getByTestId('meeting-chat').getByTestId('chat-pane');
      await expect(pane).toBeVisible();
      await expect(
        pane.getByTestId('message').filter({ hasText: 'before the call' }),
      ).toBeVisible();
      await expect(pane.getByTestId('day-separator')).toBeVisible();
      await expect(pane.getByTestId('typing-indicator')).toBeVisible();
      await expect(pane.getByTestId('composer')).toBeVisible();
      // What is said here is said in the direct chat.
      await say(aCall, 'from the call window');
      await expect(
        alice.window.getByTestId('message').filter({ hasText: 'from the call window' }),
      ).toBeVisible({ timeout: 15_000 });
      await aCall.screenshot({ path: `${SHOTS}/e2e-call-chat-direct.png` });

      // The third person joins: the direct chat leaves the call window, the call's own group
      // takes its place, for everyone.
      await aCall.getByTestId('call-more').click();
      await aCall.getByTestId('call-add').click();
      await aCall.getByTestId(`pick-${ids[2]!}`).click();
      await aCall.getByTestId('call-add-confirm').click();
      const ringCarol = await windowWithRole(carol.app, 'incoming', 30_000);
      await ringCarol.getByTestId('call-accept-audio').click();
      const cCall = await windowWithRole(carol.app, 'call');
      for (const w of [aCall, bCall, cCall])
        await expect(w.getByTestId('call-tile')).toHaveCount(3, { timeout: 30_000 });

      await expect(aCall.getByTestId('meeting-chat').getByText('before the call')).toHaveCount(0, {
        timeout: 20_000,
      });
      await say(aCall, 'hello all');
      for (const w of [bCall, cCall]) {
        if ((await w.getByTestId('meeting-chat').count()) === 0)
          await w.getByTestId('call-chat').click();
        await expect(
          w.getByTestId('meeting-chat').getByTestId('message').filter({ hasText: 'hello all' }),
        ).toBeVisible({ timeout: 30_000 });
      }
      await cCall.screenshot({ path: `${SHOTS}/e2e-call-chat-group.png` });
      // The group is not in any chat list while the call goes on; the direct chat is.
      await expect(chatRows(alice.window)).toHaveCount(1);
      await expect(chatRows(carol.window)).toHaveCount(0);

      // Carol leaves: only her window goes; the call goes on for the other two.
      await cCall.getByTestId('call-hangup').click();
      await expect.poll(() => windowCount(carol.app, 'call'), { timeout: 20_000 }).toBe(0);
      await expect(aCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 20_000 });
      await expect(bCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 20_000 });
      expect(await windowCount(alice.app, 'call')).toBe(1);
      expect(await windowCount(bob.app, 'call')).toBe(1);

      // Bob leaves too: the call is over, and the group (people wrote in it) joins the chat list
      // of everyone who was in it, with what was said.
      await bCall.getByTestId('call-hangup').click();
      await expect.poll(() => windowCount(alice.app, 'call'), { timeout: 30_000 }).toBe(0);
      await expect(chatRows(alice.window)).toHaveCount(2, { timeout: 20_000 });
      await expect(chatRows(bob.window)).toHaveCount(2, { timeout: 20_000 });
      await expect(chatRows(carol.window)).toHaveCount(1, { timeout: 20_000 });
      await carol.window.locator('button[data-testid^="conv-"]').first().click();
      await expect(
        carol.window.getByTestId('message').filter({ hasText: 'hello all' }),
      ).toBeVisible({ timeout: 15_000 });
      await carol.window.screenshot({ path: `${SHOTS}/e2e-call-chat-kept.png` });
    } finally {
      await close();
    }
  });

  test('only the organiser can end the call for everyone; an unused call chat never shows', async () => {
    test.setTimeout(240_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    try {
      const { alice, bob, carol, aCall, bCall, cCall } = await threeWay(apps, ids);
      // Others only have Leave.
      await expect(bCall.getByTestId('call-hangup')).toBeVisible();
      await expect(bCall.getByTestId('call-leave-menu')).toHaveCount(0);
      await expect(cCall.getByTestId('call-leave-menu')).toHaveCount(0);

      // The organiser has "End call for everyone", behind a confirmation.
      await aCall.getByTestId('call-leave-menu').click();
      await aCall.getByTestId('call-end-all').click();
      await expect(aCall.getByTestId('call-end-all-dialog')).toBeVisible();
      await aCall.screenshot({ path: `${SHOTS}/e2e-call-end-for-everyone.png` });
      await aCall.getByTestId('call-end-all-cancel').click();
      await expect(aCall.getByTestId('call-end-all-dialog')).toHaveCount(0);
      await expect(aCall.getByTestId('call-tile')).toHaveCount(3);

      await aCall.getByTestId('call-leave-menu').click();
      await aCall.getByTestId('call-end-all').click();
      await aCall.getByTestId('call-end-all-confirm').click();
      for (const a of [alice, bob, carol])
        await expect.poll(() => windowCount(a.app, 'call'), { timeout: 30_000 }).toBe(0);

      // Nobody wrote in the call's chat: it is in nobody's chat list, now or later.
      await bob.window.waitForTimeout(1_500);
      // (Alice has only the direct chat she started the call from; Bob and Carol have no chat.)
      await expect(chatRows(alice.window)).toHaveCount(1);
      await expect(chatRows(bob.window)).toHaveCount(0);
      await expect(chatRows(carol.window)).toHaveCount(0);
    } finally {
      await close();
    }
  });
});

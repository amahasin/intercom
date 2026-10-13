import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  clickPerson,
  expectPerson,
  appDir,
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

async function office(names: string[], extraArgs: string[] = []) {
  const roots = names.map(() => tempDataRoot());
  const port = randomPort();
  const apps = await Promise.all(
    names.map((n, i) =>
      launchApp(n, roots[i]!.path, [...lanArgs(port), '--fake-media', ...extraArgs]),
    ),
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

test.describe('M6.10 calls', () => {
  test('hands are counted, people are added from the People pane, and status is one slim row', async () => {
    test.setTimeout(240_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    const [alice, bob, carol] = apps as [RunningApp, RunningApp, RunningApp];
    try {
      await clickPerson(alice.window, ids[1]!);
      await alice.window.getByTestId('start-audio-call').click();
      const ring = await windowWithRole(bob.app, 'incoming');
      await ring.getByTestId('call-accept-audio').click();
      const aCall = await windowWithRole(alice.app, 'call');
      const bCall = await windowWithRole(bob.app, 'call');
      await expect(aCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });

      // The noise gate ("High" is the default) runs on the audio thread.
      await expect
        .poll(() =>
          aCall.evaluate(() => (window as unknown as { officemeshGate?: string }).officemeshGate),
        )
        .toBe('worklet');

      // The control bar's height with nothing to say; notices must not make it (or the picture) move.
      const barBefore = (await aCall.getByTestId('call-toolbar').boundingBox())!;
      const stageTop = (await aCall.getByTestId('call-tile').first().boundingBox())!.y;

      // Hands up are counted, in a call of two as in a group call.
      await expect(aCall.getByTestId('call-hand-badge')).toHaveCount(0);
      await bCall.getByTestId('call-hand').click();
      for (const w of [aCall, bCall])
        await expect(w.getByTestId('call-hand-badge')).toHaveText('1', { timeout: 10_000 });
      await aCall.getByTestId('call-hand').click();
      for (const w of [aCall, bCall])
        await expect(w.getByTestId('call-hand-badge')).toHaveText('2', { timeout: 10_000 });
      await aCall.getByTestId('call-hand').click();
      await expect(aCall.getByTestId('call-hand-badge')).toHaveText('1', { timeout: 10_000 });

      // The People pane counts them too, and has its own way to bring someone in.
      await aCall.getByTestId('call-people').click();
      await expect(aCall.getByTestId('people-hands')).toContainText('1');
      await aCall.getByTestId('people-add').click();
      await aCall.getByTestId(`pick-${ids[2]!}`).click();
      await aCall.getByTestId('call-add-confirm').click();
      // While she is being rung she is in the list, as "Calling".
      await expect(aCall.getByTestId('people-invited')).toHaveCount(1, { timeout: 10_000 });
      const ringCarol = await windowWithRole(carol.app, 'incoming', 30_000);
      await ringCarol.getByTestId('call-accept-audio').click();
      const cCall = await windowWithRole(carol.app, 'call');
      for (const w of [aCall, bCall, cCall])
        await expect(w.getByTestId('call-tile')).toHaveCount(3, { timeout: 30_000 });
      await expect(aCall.getByTestId('people-invited')).toHaveCount(0, { timeout: 10_000 });
      await expect(aCall.getByTestId('people-row')).toHaveCount(3);
      await aCall.screenshot({ path: `${SHOTS}/e2e-people-pane-add.png` });

      // Someone puts the call on hold: the notice is a chip in the control bar, and nothing below
      // it moves.
      await bCall.getByTestId('call-more').click();
      await bCall.getByTestId('call-hold').click();
      await expect(bCall.getByTestId('call-toolbar').getByTestId('hold-banner')).toBeVisible({
        timeout: 10_000,
      });
      const barAfter = (await bCall.getByTestId('call-toolbar').boundingBox())!;
      expect(barAfter.height).toBe(barBefore.height);
      expect((await bCall.getByTestId('call-tile').first().boundingBox())!.y).toBe(stageTop);
      await bCall.screenshot({ path: `${SHOTS}/e2e-call-status-row.png` });
    } finally {
      await close();
    }
  });

  test('a member who turned the ring down joins a running group call from the group chat', async () => {
    test.setTimeout(240_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    const [alice, bob, carol] = apps as [RunningApp, RunningApp, RunningApp];
    const ma = alice.window;
    try {
      await ma.getByTestId('new-group').click();
      await ma.getByTestId(`pick-${ids[1]}`).click();
      await ma.getByTestId(`pick-${ids[2]}`).click();
      await ma.getByTestId('group-create').click();
      await expect(ma.getByTestId('header-presence')).toContainText('3 people');
      await ma.getByTestId('start-audio-call').click();

      const ringBob = await windowWithRole(bob.app, 'incoming');
      await ringBob.getByTestId('call-accept-audio').click();
      const ringCarol = await windowWithRole(carol.app, 'incoming');
      await ringCarol.getByTestId('call-decline').click();
      await expect.poll(() => windowCount(carol.app, 'incoming'), { timeout: 15_000 }).toBe(0);
      const aCall = await windowWithRole(alice.app, 'call');
      await expect(aCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });

      // In Carol's main window, the group chat says a call is going on and offers to join it.
      await carol.window.locator('button[data-testid^="conv-"]').first().click();
      const join = carol.window.getByTestId('join-call');
      await expect(join).toBeVisible({ timeout: 20_000 });
      await carol.window.screenshot({ path: `${SHOTS}/e2e-join-group-call.png` });
      await join.click();
      const cCall = await windowWithRole(carol.app, 'call', 30_000);
      for (const w of [aCall, cCall])
        await expect(w.getByTestId('call-tile')).toHaveCount(3, { timeout: 30_000 });
      // Already in it: nothing left to join.
      await expect(carol.window.getByTestId('join-call')).toHaveCount(0);
    } finally {
      await close();
    }
  });
});

test.describe('M6.10 people lists and updates', () => {
  test('someone removed from the side pane is not offered again when a group is made', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    const a = alice.window;
    try {
      await expectPerson(a, ids[1]!).toBeVisible();
      // Bob goes away and is removed from Alice's side pane ...
      await bob.close();
      await expectPerson(a, ids[1]!).toHaveAttribute('data-online', 'false', {
        timeout: 30_000,
      });
      await clickPerson(a, ids[1]!, { button: 'right' });
      await a.getByTestId('person-remove').click();
      await expectPerson(a, ids[1]!).toHaveCount(0);
      // ... and is not in the list for a new group either.
      await a.getByTestId('rail-chat').click();
      await a.getByTestId('new-group').click();
      await expect(a.getByTestId('people-picker-filter')).toBeVisible();
      await expect(a.getByTestId(`pick-${ids[1]!}`)).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('a newer installer in the update folder has to be installed before the app is used', async () => {
    test.setTimeout(120_000);
    // Like the released build, this one is not code-signed (the dev run's own executable is).
    const { apps, close } = await office(['alice'], ['--as-unsigned-app']);
    const a = (apps[0] as RunningApp).window;
    const folder = mkdtempSync(join(tmpdir(), 'officemesh-e2e-updates-'));
    // A real, unsigned program stands in for the installer (a text file has no valid signature
    // state at all, which the check rightly refuses).
    for (const arch of ['x64', 'arm64'])
      copyFileSync(
        join(appDir, 'dist', 'main', 'rcinput.exe'),
        join(folder, `InterCom-Setup-99.0.0-${arch}.exe`),
      );
    try {
      await expect(a.getByTestId('update-required')).toHaveCount(0);
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('open-settings').click();
      await a.getByTestId('settings-tab-updates').click();
      await a.getByTestId('update-folder').fill(folder);
      await a.getByText('Save and check now').click();
      const required = a.getByTestId('update-required');
      await expect(required).toBeVisible({ timeout: 20_000 });
      await expect(required).toContainText('99.0.0');
      await a.screenshot({ path: `${SHOTS}/e2e-update-required.png` });
      // It cannot be dismissed: Escape leaves it where it is, and it has no close button.
      await a.keyboard.press('Escape');
      await expect(required).toBeVisible();
      await expect(a.getByTestId('update-required-install')).toBeEnabled();
    } finally {
      await close();
    }
  });
});

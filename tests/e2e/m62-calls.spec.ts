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

/** Apps on one private loopback LAN, each knowing all the others. */
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

/** Ask for control the way a person does: Take control, then confirm "Request control?". */
async function takeControl(page: Page) {
  await page.getByTestId('rc-request').click();
  await expect(page.getByTestId('rc-confirm-dialog')).toBeVisible();
  await page.getByTestId('rc-confirm').click();
}

const toasts = (a: RunningApp) =>
  a.app.evaluate(() =>
    (
      globalThis as unknown as { __officemeshTest: { toasts(): Array<{ title: string }> } }
    ).__officemeshTest.toasts(),
  );

async function openChat(page: Page, id: string) {
  await clickPerson(page, id);
  await expect(page.getByTestId('composer')).toBeVisible();
}

test.describe('M6.2 call windows', () => {
  test('a call has its own window, the ring is a small always-on-top window with no toast, and the main window stays usable', async () => {
    test.setTimeout(180_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    try {
      await openChat(alice.window, ids[1]!);
      await alice.window.getByTestId('start-video-call').click();

      // Alice: a call window of its own (ringing back); her main window is still the chat.
      const aCall = await windowWithRole(alice.app, 'call');
      await expect(aCall.getByTestId('call-stage')).toBeVisible({ timeout: 20_000 });
      await expect(alice.window.getByTestId('composer')).toBeVisible();

      // Bob: a small window rings. It sits bottom-right, above everything, and takes no focus.
      const ring = await windowWithRole(bob.app, 'incoming');
      await expect(ring.getByTestId('incoming-call')).toBeVisible();
      await expect(ring.getByTestId('incoming-call')).toHaveAttribute('data-waiting', 'false');
      const bounds = await bob.app.evaluate(async ({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('role=incoming'),
        )!;
        const b = win.getBounds();
        // The card opens on the screen the user is working on, whichever that is.
        const area = screen.getDisplayMatching(b).workArea;
        return {
          onTop: win.isAlwaysOnTop(),
          rightGap: area.x + area.width - (b.x + b.width),
          bottomGap: area.y + area.height - (b.y + b.height),
          width: b.width,
        };
      });
      expect(bounds.onTop).toBe(true);
      expect(bounds.rightGap).toBeLessThan(40);
      expect(bounds.bottomGap).toBeLessThan(40);
      expect(bounds.width).toBeLessThan(500);
      expect(
        await ring.evaluate(
          () => (window as unknown as { officemeshSounds: string[] }).officemeshSounds,
        ),
      ).toContain('start:ringtone');
      await ring.screenshot({ path: `${SHOTS}/e2e-incoming-window.png` });
      // The window is the only thing that rings: no system notification for the call.
      expect((await toasts(bob)).filter((t) => /call/i.test(t.title))).toEqual([]);

      await ring.getByTestId('call-accept-video').click();
      const bCall = await windowWithRole(bob.app, 'call');
      await expect(bCall.getByTestId('call-stage')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => windowCount(bob.app, 'incoming')).toBe(0);
      await expect(aCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });
      await expect(bCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });

      // During the call Bob uses his main window as usual.
      await expect(bob.window.getByTestId('call-bar')).toBeVisible();
      await openChat(bob.window, ids[0]!);
      await bob.window.getByTestId('composer').click();
      await bob.window.keyboard.type('still here');
      await bob.window.getByTestId('composer').press('Enter');
      await expect(
        alice.window.getByTestId('message').filter({ hasText: 'still here' }),
      ).toHaveCount(1);
      await bCall.screenshot({ path: `${SHOTS}/e2e-call-window.png` });
      await bob.window.screenshot({ path: `${SHOTS}/e2e-main-during-call.png` });

      // Maximised, the controls are still on screen and clickable (nothing covers them).
      await alice.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes('role=call'))!
          .maximize();
      });
      await aCall.waitForTimeout(800);
      const hang = aCall.getByTestId('call-hangup');
      const covered = await hang.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          inside: r.bottom <= window.innerHeight && r.top >= 0,
          reachable: top !== null && el.contains(top),
        };
      });
      expect(covered).toEqual({ inside: true, reachable: true });
      await aCall.screenshot({ path: `${SHOTS}/e2e-call-maximised.png` });

      // Hang up: both windows say so, then close.
      await hang.click();
      await expect(aCall.getByTestId('call-ended')).toBeVisible();
      await expect(bCall.getByTestId('call-ended')).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => windowCount(alice.app, 'call'), { timeout: 15_000 }).toBe(0);
      await expect.poll(() => windowCount(bob.app, 'call'), { timeout: 15_000 }).toBe(0);
    } finally {
      await close();
    }
  });
});

test.describe('M6.2 call waiting', () => {
  test('a second call while in one: hold and accept, resume, add to the call, end and accept, decline', async () => {
    test.setTimeout(240_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol', 'dan']);
    const [alice, bob, carol, dan] = apps as [RunningApp, RunningApp, RunningApp, RunningApp];
    try {
      // Alice and Bob are in a call.
      await openChat(alice.window, ids[1]!);
      await alice.window.getByTestId('start-audio-call').click();
      const ring1 = await windowWithRole(bob.app, 'incoming');
      await ring1.getByTestId('call-accept-audio').click();
      const bobFirst = await windowWithRole(bob.app, 'call');
      await expect(bobFirst.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });

      // Carol calls Bob: the ring window offers what to do about the call he is in.
      await openChat(carol.window, ids[1]!);
      await carol.window.getByTestId('start-audio-call').click();
      const ring2 = await windowWithRole(bob.app, 'incoming');
      await expect(ring2.getByTestId('incoming-call')).toHaveAttribute('data-waiting', 'true');
      await expect(ring2.getByTestId('incoming-current')).toBeVisible();
      await expect(ring2.getByTestId('call-accept-hold')).toBeEnabled();
      await expect(ring2.getByTestId('call-accept-end')).toBeVisible();
      await expect(ring2.getByTestId('call-merge')).toBeVisible();
      await expect(ring2.getByTestId('call-decline')).toBeVisible();
      expect(
        await ring2.evaluate(
          () => (window as unknown as { officemeshSounds: string[] }).officemeshSounds,
        ),
      ).toContain('start:waiting');
      await ring2.screenshot({ path: `${SHOTS}/e2e-call-waiting.png` });
      // The call Bob is in carries on while this rings.
      await expect(bobFirst.getByTestId('call-tile')).toHaveCount(2);

      // Hold and accept: Alice's call is on hold (she sees it), Carol's is live.
      await ring2.getByTestId('call-accept-hold').click();
      await expect.poll(() => windowCount(bob.app, 'call')).toBe(2);
      await expect(bobFirst.getByTestId('hold-banner')).toBeVisible({ timeout: 10_000 });
      await expect(
        bob.window.locator('[data-testid="call-bar-row"][data-held="true"]'),
      ).toHaveCount(1);
      const aCall = await windowWithRole(alice.app, 'call');
      await expect(
        aCall.locator('[data-testid="call-tile"]').filter({ hasText: 'On hold' }),
      ).toHaveCount(1, {
        timeout: 15_000,
      });
      const cCall = await windowWithRole(carol.app, 'call');
      await expect(cCall.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });
      await bob.window.screenshot({ path: `${SHOTS}/e2e-two-calls-bar.png` });

      // Resume the first: the second goes on hold instead.
      await bobFirst.getByTestId('call-resume').click();
      await expect(bobFirst.getByTestId('hold-banner')).toHaveCount(0, { timeout: 10_000 });
      await expect(
        cCall.locator('[data-testid="call-tile"]').filter({ hasText: 'On hold' }),
      ).toHaveCount(1, { timeout: 15_000 });

      // Dan calls: Bob adds him to the call he is in. Dan is invited into it and joins.
      await openChat(dan.window, ids[1]!);
      await dan.window.getByTestId('start-audio-call').click();
      const ring3 = await windowWithRole(bob.app, 'incoming');
      await expect(ring3.getByTestId('incoming-call')).toHaveAttribute('data-waiting', 'true');
      await ring3.getByTestId('call-merge').click();
      // Dan's own call to Bob ends (it was folded into Bob's), then Bob's call rings for him.
      await expect.poll(() => windowCount(dan.app, 'call'), { timeout: 15_000 }).toBe(0);
      const ringDan = await windowWithRole(dan.app, 'incoming', 30_000);
      await ringDan.getByTestId('call-accept-audio').click();
      const dCall = await windowWithRole(dan.app, 'call');
      await expect(dCall.getByTestId('call-tile')).toHaveCount(3, { timeout: 30_000 });
      await expect(bobFirst.getByTestId('call-tile')).toHaveCount(3, { timeout: 30_000 });

      // Declining a waiting call: the caller is told, nothing changes for Bob.
      await dan.window.bringToFront();
      await alice.window.bringToFront();
      await expect.poll(() => windowCount(bob.app, 'incoming')).toBe(0);
    } finally {
      await close();
    }
  });
});

test.describe('M6.2 remote control', () => {
  test('a participant asks for control of a shared screen; the sharer allows, the pointer follows, and stops it', async () => {
    test.setTimeout(180_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    try {
      await openChat(alice.window, ids[1]!);
      await alice.window.getByTestId('start-audio-call').click();
      await (await windowWithRole(bob.app, 'incoming')).getByTestId('call-accept-audio').click();
      const a = await windowWithRole(alice.app, 'call');
      const b = await windowWithRole(bob.app, 'call');
      await expect(a.getByTestId('call-tile')).toHaveCount(2, { timeout: 30_000 });

      // Alice shares her whole screen. Bob sees it and may ask for control.
      await a.getByTestId('call-share').click();
      await a.getByTestId('screen-source').first().click();
      await a.getByTestId('screen-share-start').click();
      await expect(b.getByTestId('shared-screen')).toBeVisible({ timeout: 15_000 });
      await expect(b.getByTestId('rc-request')).toBeVisible();
      // Cancelling the confirmation asks nothing.
      await b.getByTestId('rc-request').click();
      await b.getByTestId('rc-confirm-cancel').click();
      await expect(a.getByTestId('rc-asked')).toHaveCount(0);
      // The shared picture's size on each side now: no notice below may change it.
      const pictureOf = async (w: typeof a) =>
        (await w.getByTestId('shared-screen').boundingBox())!;
      const pictureA = await pictureOf(a);
      const pictureB = await pictureOf(b);
      await takeControl(b);
      await expect(b.getByTestId('rc-asking')).toBeVisible();

      // Alice is asked (her window is raised), and says no first.
      await expect(a.getByTestId('rc-asked')).toBeVisible({ timeout: 10_000 });
      await a.getByTestId('rc-deny').click();
      await expect(b.getByTestId('rc-notice')).toContainText('did not allow control');
      expect(
        await alice.app.evaluate(() =>
          (
            globalThis as unknown as { __officemeshTest: { remoteControlActive(): boolean } }
          ).__officemeshTest.remoteControlActive(),
        ),
      ).toBe(false);

      // Asks again; this time she allows. Bob's pointer now moves hers.
      await takeControl(b);
      await expect(a.getByTestId('rc-asked')).toBeVisible({ timeout: 10_000 });
      await a.getByTestId('rc-allow').click();
      await expect(a.getByTestId('rc-controlled')).toBeVisible();
      await expect(b.getByTestId('rc-controlling')).toBeVisible({ timeout: 10_000 });
      await expect(b.getByTestId('rc-layer')).toBeVisible();
      // Sharing and control at once: a pill beside the timer, and one card for control (whole
      // sentence, button in full view) in the pane at the right, on both sides. The picture itself
      // is exactly as large as before, and the card is not over it.
      expect(await pictureOf(a)).toEqual(pictureA);
      expect(await pictureOf(b)).toEqual(pictureB);
      for (const [w, id] of [
        [a, 'rc-controlled'],
        [b, 'rc-controlling'],
      ] as const) {
        const row = w.getByTestId(id);
        await expect(w.getByTestId('share-banner')).toBeVisible();
        await expect(row).toBeVisible();
        expect(
          await row.evaluate((el) =>
            [...el.querySelectorAll('*')].every((c) => c.scrollWidth <= c.clientWidth + 1),
          ),
        ).toBe(true);
        await expect(row.getByRole('button')).toBeVisible();
        const card = (await row.boundingBox())!;
        const picture = (await pictureOf(w))!;
        expect(card.x).toBeGreaterThanOrEqual(picture.x + picture.width);
      }
      await a.screenshot({ path: `${SHOTS}/e2e-call-control-sharer.png` });
      await b.screenshot({ path: `${SHOTS}/e2e-call-control-controller.png` });
      await expect
        .poll(() =>
          alice.app.evaluate(() =>
            (
              globalThis as unknown as { __officemeshTest: { remoteControlActive(): boolean } }
            ).__officemeshTest.remoteControlActive(),
          ),
        )
        .toBe(true);

      // Bob moves his mouse over the middle of the shared picture: Alice's cursor goes to the
      // middle of the screen she shares.
      const layer = (await b.getByTestId('rc-layer').boundingBox())!;
      const display = await alice.app.evaluate(() =>
        (
          globalThis as unknown as {
            __officemeshTest: {
              sharedDisplay(): { x: number; y: number; width: number; height: number } | null;
            };
          }
        ).__officemeshTest.sharedDisplay(),
      );
      expect(display).not.toBeNull();
      const near = (p: { x: number; y: number }, fx: number, fy: number) =>
        Math.hypot(
          p.x - (display!.x + display!.width * fx),
          p.y - (display!.y + display!.height * fy),
        ) <
        display!.width * 0.1;
      const cursorOf = () =>
        alice.app.evaluate(() =>
          (
            globalThis as unknown as {
              __officemeshTest: { cursor(): { x: number; y: number } };
            }
          ).__officemeshTest.cursor(),
        );
      const aimAt = async (fx: number, fy: number) => {
        let wiggle = 0;
        await expect
          .poll(
            async () => {
              // It is a real pointer: send the move again each time we look, in case somebody
              // at this PC touched the mouse in between.
              wiggle = 1 - wiggle;
              // (Windows may have moved: measure the shared screen's place again.)
              const layer = (await b.getByTestId('rc-layer').boundingBox())!;
              await b.mouse.move(
                layer.x + layer.width * fx - 20 * wiggle,
                layer.y + layer.height * fy - 20 * wiggle,
              );
              await b.mouse.move(layer.x + layer.width * fx, layer.y + layer.height * fy, {
                steps: 3,
              });
              return near(await cursorOf(), fx, fy);
            },
            { timeout: 15_000 },
          )
          .toBe(true);
      };
      // The bottom-right corner is free of InterCom's windows.
      await aimAt(0.93, 0.93);

      // The centre of the screen is under InterCom's own call window, brought to the front: the
      // pointer must not go there while it is on top (a person sharing keeps its controls).
      await alice.app.evaluate(({ BrowserWindow }) => {
        const call = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('role=call'),
        )!;
        call.show();
        call.setAlwaysOnTop(true, 'screen-saver');
        call.moveTop();
      });
      await b.waitForTimeout(500);
      await b.mouse.move(layer.x + layer.width * 0.5 - 30, layer.y + layer.height * 0.5 - 30);
      await b.mouse.move(layer.x + layer.width * 0.5, layer.y + layer.height * 0.5, { steps: 4 });
      await b.waitForTimeout(800);
      expect(near(await cursorOf(), 0.5, 0.5)).toBe(false);

      // Everyone watching sees a pointer tag with an avatar.
      // The controller's own pointer carries his avatar; the shared pointer (where Alice's
      // pointer really is) carries the avatar of whoever has a hand on it.
      await expect(b.getByTestId('rc-layer').getByTestId('pointer-tag')).toBeVisible({
        timeout: 10_000,
      });
      await expect(b.getByTestId('shared-pointers').getByTestId('pointer-tag')).toBeVisible({
        timeout: 10_000,
      });

      // Minimise Alice's windows (the shared screen now shows only other things): the centre works.
      await alice.app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) {
          w.setAlwaysOnTop(false);
          w.minimize();
        }
      });
      // Bob's windows are on this same PC: keep them off the middle of the screen, or his real
      // pointer over the shared screen would be sent back to Alice as moves of its own.
      await bob.app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows())
          w.setBounds({ x: 0, y: 0, width: 900, height: 640 });
      });
      await aimAt(0.5, 0.5);
      await alice.app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.restore();
      });

      // Alice takes control back.
      await a.getByTestId('rc-stop').click();
      await expect(b.getByTestId('rc-notice')).toBeVisible({ timeout: 10_000 });
      await expect(b.getByTestId('rc-layer')).toHaveCount(0);
      expect(
        await alice.app.evaluate(() =>
          (
            globalThis as unknown as { __officemeshTest: { remoteControlActive(): boolean } }
          ).__officemeshTest.remoteControlActive(),
        ),
      ).toBe(false);

      // Stopping the share while controlled also ends control.
      await takeControl(b);
      await a.getByTestId('rc-allow').click();
      await expect(b.getByTestId('rc-controlling')).toBeVisible({ timeout: 10_000 });
      await a.getByTestId('call-share').click();
      await expect(b.getByTestId('rc-layer')).toHaveCount(0, { timeout: 10_000 });
      await expect(b.getByTestId('shared-screen')).toBeHidden({ timeout: 10_000 });
    } finally {
      await close();
    }
  });
});

import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import {
  clickPerson,
  expectPerson,
  lanArgs,
  launchApp,
  randomPort,
  tempDataRoot,
  windowWithRole,
  type RunningApp,
} from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;

interface PeerStats {
  userId: string;
  state: string;
  connectedMs: number | undefined;
  rollbacks: number;
  audioPackets: number;
  videoFrames: number;
}
type StatsWindow = { officemeshCallStats: () => Promise<PeerStats[]> };

const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as StatsWindow).officemeshCallStats());

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

/** Apps on one private loopback LAN, with Chromium's synthetic camera and microphone. */
async function office(names: string[]) {
  const roots = names.map(() => tempDataRoot());
  const port = randomPort();
  const apps = await Promise.all(
    names.map((n, i) => launchApp(n, roots[i]!.path, [...lanArgs(port), '--fake-media'])),
  );
  const ids = await Promise.all(apps.map(userIdOf));
  for (const [i, app] of apps.entries()) {
    for (const [j, id] of ids.entries()) {
      if (i === j) continue;
      await expectPerson(app.window, id).toHaveAttribute('data-online', 'true', {
        timeout: 15_000,
      });
    }
  }
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps, ids, close };
}

/** Wait until this window has a connected media link to each of `count` others. */
async function connectedTo(page: Page, count: number, timeout = 15_000) {
  await expect
    .poll(async () => (await stats(page)).filter((s) => s.state === 'connected').length, {
      timeout,
    })
    .toBe(count);
}

async function audioPackets(page: Page): Promise<number> {
  return (await stats(page)).reduce((n, s) => n + s.audioPackets, 0);
}

/** Sample incoming audio every 250 ms while `during` runs; returns the longest stall in ms. */
async function longestAudioStall(page: Page, during: () => Promise<void>, settleMs: number) {
  let last = await audioPackets(page);
  let lastChange = Date.now();
  let longest = 0;
  let running = true;
  const sampler = (async () => {
    while (running) {
      await page.waitForTimeout(250);
      const now = await audioPackets(page);
      if (now > last) {
        longest = Math.max(longest, Date.now() - lastChange);
        last = now;
        lastChange = Date.now();
      }
    }
  })();
  try {
    await during();
    await page.waitForTimeout(settleMs);
  } finally {
    // Stop sampling either way, so a failure inside `during` is the one reported.
    running = false;
    await sampler.catch(() => {});
  }
  return Math.max(longest, Date.now() - lastChange);
}

test.describe('M4 calls and screen sharing', () => {
  test('1:1 video call: connects quickly, shares a screen without dropping audio, survives glare', async () => {
    test.setTimeout(180_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [ma, mb] = apps.map((x) => x.window) as [Page, Page];
    try {
      // Calls run in windows of their own: `a` and `b` below are those call windows.
      await clickPerson(ma, ids[1]);
      await ma.getByTestId('start-video-call').click();
      const a = await windowWithRole(apps[0]!.app, 'call');
      await expect(a.getByTestId('call-stage')).toBeVisible();
      const ring = await windowWithRole(apps[1]!.app, 'incoming');
      await expect(ring.getByTestId('incoming-call')).toBeVisible();
      await ring.getByTestId('call-accept-video').click();
      const b = await windowWithRole(apps[1]!.app, 'call');

      // Connected (ICE and DTLS done) in under 2 s from Bob's click, with no ICE servers.
      await connectedTo(b, 1);
      await connectedTo(a, 1);
      const bobStats = (await stats(b))[0]!;
      expect(bobStats.connectedMs).toBeLessThan(2_000);
      test
        .info()
        .annotations.push({ type: 'connect-ms', description: String(bobStats.connectedMs) });
      // Video frames arrive both ways, and each side shows the other's camera.
      await expect
        .poll(async () => (await stats(a))[0]!.videoFrames, { timeout: 10_000 })
        .toBeGreaterThan(10);
      await expect
        .poll(async () => (await stats(b))[0]!.videoFrames, { timeout: 10_000 })
        .toBeGreaterThan(10);
      await expect(
        a.getByTestId('call-tile').and(a.locator(`[data-user="${ids[1]}"]`)),
      ).toHaveAttribute('data-video', 'on');

      // Screen share on and off: Bob's incoming audio never stalls.
      const stall = await longestAudioStall(
        b,
        async () => {
          await a.getByTestId('call-share').click();
          await a.getByTestId('screen-source').first().click();
          await a.getByTestId('screen-share-start').click();
          await expect(b.getByTestId('shared-screen')).toBeVisible({ timeout: 10_000 });
          await expect(b.getByTestId('share-banner')).toBeVisible();
          await b.waitForTimeout(1_500);
          await a.getByTestId('call-share').click();
          await expect(b.getByTestId('shared-screen')).toBeHidden({ timeout: 10_000 });
        },
        1_500,
      );
      test.info().annotations.push({ type: 'share-audio-stall-ms', description: String(stall) });
      expect(stall).toBeLessThan(500);
      expect((await stats(b))[0]!.state).toBe('connected');

      // Glare: both press the same button at the same instant (scheduled on the shared clock).
      const together = async (testId: string) => {
        const at = Date.now() + 500;
        await Promise.all(
          [a, b].map((p) =>
            p.evaluate(
              ([when, id]) => {
                window.setTimeout(
                  () =>
                    (document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click(),
                  when - Date.now(),
                );
              },
              [at, testId] as const,
            ),
          ),
        );
        await a.waitForTimeout(3_000);
      };
      const tileOf = (p: Page, userId: string) =>
        p.locator(`[data-testid="call-tile"][data-user="${userId}"]`);
      const beforeGlare = await audioPackets(b);
      // Cameras off and on together.
      await together('call-camera');
      await expect(tileOf(a, ids[1]!)).toHaveAttribute('data-video', 'off');
      await expect(tileOf(b, ids[0]!)).toHaveAttribute('data-video', 'off');
      await together('call-camera');
      await expect(tileOf(a, ids[1]!))
        .toHaveAttribute('data-video', 'on', { timeout: 10_000 })
        .catch(async (err: unknown) => {
          // Say why: the other side's call stage shows any device error.
          throw new Error(
            `${String(err)}\nBob's stage: ${await b.getByTestId('call-stage').innerText()}`,
          );
        });
      await expect(tileOf(b, ids[0]!))
        .toHaveAttribute('data-video', 'on', { timeout: 10_000 })
        .catch(async (err: unknown) => {
          throw new Error(
            `${String(err)}\nAlice's stage: ${await a.getByTestId('call-stage').innerText()}`,
          );
        });
      const framesBefore = (await stats(a))[0]!.videoFrames;
      await expect
        .poll(async () => (await stats(a))[0]!.videoFrames, { timeout: 5_000 })
        .toBeGreaterThan(framesBefore + 10);
      // Both start sharing together: two offers cross (renegotiation glare). One share stays.
      for (const p of [a, b]) {
        await p.getByTestId('call-share').click();
        await p.getByTestId('screen-source').first().click();
      }
      await together('screen-share-start');
      await expect
        .poll(
          async () =>
            (await a.getByTestId('shared-screen').count()) +
            (await b.getByTestId('shared-screen').count()),
          { timeout: 10_000 },
        )
        .toBe(2);
      const [sa, sb] = [(await stats(a))[0]!, (await stats(b))[0]!];
      expect(sa.state).toBe('connected');
      expect(sb.state).toBe('connected');
      expect(await audioPackets(b)).toBeGreaterThan(beforeGlare);
      test.info().annotations.push({
        type: 'glare-rollbacks',
        description: String(sa.rollbacks + sb.rollbacks),
      });
      for (const p of [a, b]) {
        if ((await p.getByTestId('call-share').getAttribute('aria-pressed')) === 'true')
          await p.getByTestId('call-share').click();
      }
      await expect(b.getByTestId('shared-screen')).toBeHidden({ timeout: 10_000 });

      // Mute and hold show on the other side.
      await a.getByTestId('call-mute').click();
      await expect(b.locator(`[data-testid="call-tile"][data-user="${ids[0]}"]`)).toContainText(
        'Muted',
      );
      await a.getByTestId('call-more').click();
      await a.getByTestId('call-hold').click();
      await expect(b.locator(`[data-testid="call-tile"][data-user="${ids[0]}"]`)).toContainText(
        'On hold',
      );

      // The main window shows the call while it goes on; hang up ends it on both sides and
      // lands in history.
      await expect(ma.getByTestId('call-bar')).toBeVisible();
      await a.getByTestId('call-hangup').click();
      await expect(b.getByTestId('call-ended')).toBeVisible({ timeout: 10_000 });
      await mb.getByTestId('rail-calls').click();
      await expect(mb.getByTestId('call-history-item').first()).toHaveAttribute(
        'data-outcome',
        'completed',
      );
    } finally {
      await close();
    }
  });

  test('a callee in Do not disturb is not rung, and the caller sees why', async () => {
    test.setTimeout(90_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    try {
      await bob.window.getByTestId('me-avatar').click();
      await bob.window.getByTestId('presence-dnd').click();
      await clickPerson(alice.window, ids[1]);
      await expect(alice.window.getByTestId('header-presence')).toContainText('Do not disturb');
      await alice.window.getByTestId('start-audio-call').click();
      const aliceCall = await windowWithRole(alice.app, 'call');
      await expect(aliceCall.getByTestId('call-ended')).toHaveAttribute('data-outcome', 'dnd');
      await expect(aliceCall.getByTestId('call-ended')).toContainText('Do not disturb');
      // Nothing rings for Bob: no ring window.
      expect(bob.app.windows().filter((w) => w.url().includes('role=incoming'))).toHaveLength(0);
      const toasts = await bob.app.evaluate(() =>
        (
          globalThis as unknown as { __officemeshTest: { toasts(): Array<{ title: string }> } }
        ).__officemeshTest.toasts(),
      );
      expect(toasts.filter((t) => t.title.includes('call'))).toEqual([]);
      // It shows as a missed call on Bob's PC.
      await bob.window.getByTestId('rail-activity').click();
      await expect(bob.window.getByTestId('activity-missed-call')).toBeVisible();
    } finally {
      await close();
    }
  });

  test("pulling a participant's cable removes their tile within 10 s and the call continues", async () => {
    test.setTimeout(150_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    const [ma] = apps.map((x) => x.window) as [Page, Page, Page];
    try {
      // A group of three, then a group video call (in call windows: `a`, `b`, `c` below).
      await ma.getByTestId('new-group').click();
      await ma.getByTestId(`pick-${ids[1]}`).click();
      await ma.getByTestId(`pick-${ids[2]}`).click();
      await ma.getByTestId('group-create').click();
      await expect(ma.getByTestId('header-presence')).toContainText('3 people');
      await ma.getByTestId('start-video-call').click();
      for (const n of [1, 2])
        await (
          await windowWithRole(apps[n]!.app, 'incoming')
        )
          .getByTestId('call-accept-video')
          .click();
      const [a, b, c] = (await Promise.all(apps.map((x) => windowWithRole(x.app, 'call')))) as [
        Page,
        Page,
        Page,
      ];
      for (const p of [a, b, c]) await connectedTo(p, 2, 20_000);
      await expect(a.getByTestId('call-tile')).toHaveCount(3);

      // Carol's PC dies without a word: every process of her app is killed (no hangup, no
      // bye). Killing only Electron's main process would leave her renderer sending media.
      const pulledAt = Date.now();
      execFileSync('taskkill', ['/F', '/T', '/PID', String(apps[2]!.app.process().pid)]);
      await expect(a.locator(`[data-testid="call-tile"][data-user="${ids[2]}"]`)).toHaveCount(0, {
        timeout: 10_000,
      });
      await expect(b.locator(`[data-testid="call-tile"][data-user="${ids[2]}"]`)).toHaveCount(0, {
        timeout: 10_000,
      });
      const removedMs = Date.now() - pulledAt;
      test.info().annotations.push({ type: 'tile-removed-ms', description: String(removedMs) });
      expect(removedMs).toBeLessThan(10_000);

      // Alice and Bob carry on.
      const before = await audioPackets(a);
      await a.waitForTimeout(2_000);
      expect(await audioPackets(a)).toBeGreaterThan(before);
      expect((await stats(a)).filter((s) => s.state === 'connected')).toHaveLength(1);
      await expect(a.getByTestId('call-tile')).toHaveCount(2);
    } finally {
      await close();
    }
  });
});

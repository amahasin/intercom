import { expect, test, type Page } from '@playwright/test';
import { lanArgs, launchApp, randomPort, tempDataRoot, type RunningApp } from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;

interface PeerStats {
  userId: string;
  state: string;
  audioPackets: number;
  videoFrames: number;
}
type TestWindow = {
  officemeshCallStats: () => Promise<PeerStats[]>;
  officemeshBlurStats: () => { on: boolean; fps: number; inputFps: number };
  officemeshWhiteboard: () => string;
  __officemeshBlurDelayMs?: number;
};
const stats = (p: Page) =>
  p.evaluate(() => (window as unknown as TestWindow).officemeshCallStats());
const blurStats = (p: Page) =>
  p.evaluate(() => (window as unknown as TestWindow).officemeshBlurStats());
const board = (p: Page) =>
  p.evaluate(() => (window as unknown as TestWindow).officemeshWhiteboard());

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

/** Apps on one private loopback LAN, each knowing all the others. */
async function office(names: string[], port = randomPort()) {
  const roots = names.map(() => tempDataRoot());
  const apps = await Promise.all(
    names.map((n, i) => launchApp(n, roots[i]!.path, [...lanArgs(port), '--fake-media'])),
  );
  const ids = await Promise.all(apps.map(userIdOf));
  for (const [i, app] of apps.entries()) {
    for (const [j, id] of ids.entries()) {
      if (i !== j) {
        await expect(app.window.getByTestId(`person-${id}`)).toHaveAttribute(
          'data-online',
          'true',
          { timeout: 15_000 },
        );
      }
    }
  }
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps, ids, roots, port, close };
}

/** A group chat of everyone, created by the first app, open on every app. */
async function groupOf(pages: Page[], ids: string[], title: string) {
  const [host] = pages as [Page];
  await host.getByTestId('new-group').click();
  await host.getByTestId('group-title').fill(title);
  for (const id of ids.slice(1)) await host.getByTestId(`pick-${id}`).click();
  await host.getByTestId('group-create').click();
  for (const p of pages.slice(1)) await p.getByTestId('chat-list').getByText(title).click();
}

async function connected(p: Page): Promise<number> {
  return (await stats(p)).filter((s) => s.state === 'connected').length;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test.describe('M5 meetings', () => {
  test('a scheduled meeting reaches every invitee, including one who was offline', async () => {
    test.setTimeout(120_000);
    const { apps, ids, roots, port, close } = await office(['alice', 'bob', 'carol']);
    const [a, b] = [apps[0]!.window, apps[1]!.window];
    try {
      // Carol goes offline before the meeting is scheduled.
      await apps[2]!.close();
      await a.getByTestId('rail-calendar').click();
      await a.getByTestId('meeting-new').click();
      await a.getByTestId('meeting-title').fill('Quarterly planning');
      await a.getByTestId('meeting-date').fill(today());
      await a.getByTestId('meeting-start').fill('10:00');
      await a.getByTestId('meeting-end').fill('11:00');
      await a.getByTestId(`pick-${ids[1]}`).click();
      await a.getByTestId(`pick-${ids[2]}`).click();
      await a.getByTestId('meeting-schedule').click();
      await a.getByRole('tab', { name: 'Week', exact: true }).click();
      await expect(
        a.locator('[data-testid="calendar-event"][data-title="Quarterly planning"]'),
      ).toBeVisible();

      await b.getByTestId('rail-calendar').click();
      await b.getByRole('tab', { name: 'Week', exact: true }).click();
      await expect(
        b.locator('[data-testid="calendar-event"][data-title="Quarterly planning"]'),
      ).toBeVisible({ timeout: 10_000 });

      // Carol comes back: the meeting is on her calendar too.
      const carol = await launchApp('carol', roots[2]!.path, [...lanArgs(port), '--fake-media']);
      apps[2] = carol;
      await carol.window.getByTestId('rail-calendar').click();
      await carol.window.getByRole('tab', { name: 'Week', exact: true }).click();
      await expect(
        carol.window.locator('[data-testid="calendar-event"][data-title="Quarterly planning"]'),
      ).toBeVisible({ timeout: 30_000 });
      // The meeting card in the meeting chat takes an RSVP.
      await carol.window.getByTestId('rail-chat').click();
      await carol.window.getByTestId('chat-list').getByText('Quarterly planning').first().click();
      await carol.window.getByTestId('rsvp-accepted').click();
      await a.getByTestId('rail-chat').click();
      await a.getByTestId('chat-list').getByText('Quarterly planning').first().click();
      await expect(a.getByTestId('meeting-card')).toContainText('1 accepted');
    } finally {
      await close();
    }
  });

  test('a late joiner gets the roster and all streams within 3 s; hand, reactions, mute all, chat', async () => {
    test.setTimeout(180_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol', 'dave']);
    const pages = apps.map((x) => x.window);
    const [a, b, c, d] = pages as [Page, Page, Page, Page];
    try {
      await groupOf(pages, ids, 'Design crit');
      await a.getByTestId('meet-now').click();
      await expect(a.getByTestId('call-stage'))
        .toBeVisible()
        .catch(async (err: unknown) => {
          throw new Error(`${String(err)}
message: ${await a
            .getByTestId('call-message')
            .textContent()
            .catch(() => '')}`);
        });
      for (const p of [b, c]) {
        await p.getByTestId('call-card-join').click({ timeout: 15_000 });
      }
      for (const p of [a, b, c]) await expect.poll(() => connected(p), { timeout: 20_000 }).toBe(2);

      // Dave joins late: everyone's roster and every stream within 3 seconds.
      await expect(d.getByTestId('call-card-join')).toBeEnabled({ timeout: 10_000 });
      const t0 = Date.now();
      await d.getByTestId('call-card-join').click();
      await expect
        .poll(
          async () => {
            const s = await stats(d);
            return s.filter(
              (x) => x.state === 'connected' && x.videoFrames > 0 && x.audioPackets > 0,
            ).length;
          },
          { timeout: 10_000, intervals: [50] },
        )
        .toBe(3);
      const joinMs = Date.now() - t0;
      test.info().annotations.push({ type: 'late-join-ms', description: String(joinMs) });
      expect(joinMs).toBeLessThan(3_000);
      await expect(d.getByTestId('call-tile')).toHaveCount(4);

      // Raise hand and react: everyone sees it.
      await b.getByTestId('call-hand').click();
      await expect(d.locator(`[data-testid="call-tile"][data-user="${ids[1]}"]`)).toHaveAttribute(
        'data-hand',
        'up',
      );
      await c.getByTestId('call-react').click();
      await c.getByTestId('react-👏').click();
      await expect(
        d.locator(`[data-testid="call-tile"][data-user="${ids[2]}"] [data-testid="reaction"]`),
      ).toHaveText('👏');

      // The organiser mutes everyone; a participant cannot.
      await expect(b.getByTestId('call-more')).toBeVisible();
      await b.getByTestId('call-more').click();
      await expect(b.getByTestId('call-mute-all')).toHaveCount(0);
      await b.keyboard.press('Escape');
      await a.getByTestId('call-more').click();
      await a.getByTestId('call-mute-all').click();
      await expect(b.getByTestId('call-message')).toContainText('organiser muted you');
      await expect(a.locator(`[data-testid="call-tile"][data-user="${ids[3]}"]`)).toContainText(
        'Muted',
      );

      // Meeting chat beside the call is the group's own chat.
      await d.getByTestId('call-chat').click();
      await d.getByTestId('meeting-chat').getByTestId('composer').click();
      await d.keyboard.type('Can everyone see my screen?');
      await d.keyboard.press('Enter');
      await a.getByTestId('call-chat').click();
      await expect(a.getByTestId('meeting-chat')).toContainText('Can everyone see my screen?');

      // When the last person leaves, the card says the meeting is over.
      for (const p of [b, c, d, a]) await p.getByTestId('call-hangup').click();
      await expect(b.getByTestId('call-card').last()).toHaveAttribute('data-ended', 'true', {
        timeout: 10_000,
      });
    } finally {
      await close();
    }
  });

  test('whiteboard merges simultaneous drawing; blur holds 24 fps and switches off when too slow; recording banner and file', async () => {
    test.setTimeout(240_000);
    const { apps, ids, roots, close } = await office(['alice', 'bob']);
    const [a, b] = apps.map((x) => x.window) as [Page, Page];
    try {
      await groupOf([a, b], ids, 'Standup');
      await a.getByTestId('meet-now').click();
      await b.getByTestId('call-card-join').click({ timeout: 15_000 });
      for (const p of [a, b]) await expect.poll(() => connected(p), { timeout: 20_000 }).toBe(1);

      // --- Whiteboard: both draw at the same moment, several times.
      await a.getByTestId('call-whiteboard').click();
      await b.getByTestId('call-whiteboard').click();
      const draw = async (p: Page, row: number) => {
        const box = (await p.getByTestId('wb-canvas').boundingBox())!;
        for (let i = 0; i < 5; i++) {
          const y = box.y + box.height * (0.1 + row * 0.4 + i * 0.05);
          await p.mouse.move(box.x + box.width * 0.1, y);
          await p.mouse.down();
          for (let s = 1; s <= 8; s++)
            await p.mouse.move(box.x + box.width * (0.1 + s * 0.08), y + (s % 2) * 6);
          await p.mouse.up();
        }
      };
      await Promise.all([draw(a, 0), draw(b, 1)]);
      await expect.poll(async () => JSON.parse(await board(a)).length, { timeout: 5_000 }).toBe(10);
      await expect
        .poll(async () => (await board(a)) === (await board(b)), { timeout: 10_000 })
        .toBe(true)
        .catch(async (err: unknown) => {
          const [x, y] = [JSON.parse(await board(a)), JSON.parse(await board(b))] as Array<
            Array<{ id: string; points: number[] }>
          >;
          const summary = (l: Array<{ id: string; points: number[] }> | undefined) =>
            (l ?? []).map((i) => `${i.id.slice(0, 4)}:${i.points.length}`).join(' ');
          throw new Error(`${String(err)}
A ${summary(x)}
B ${summary(y)}`);
        });
      const pixels = (p: Page) =>
        p.evaluate(() =>
          (document.querySelector('[data-testid="wb-canvas"]') as HTMLCanvasElement).toDataURL(),
        );
      expect(await pixels(a)).toBe(await pixels(b));
      await a.getByTestId('wb-close').click();
      await b.getByTestId('wb-close').click();

      // --- Background blur at 720p.
      await a.getByTestId('call-more').click();
      await a.getByTestId('call-blur').click();
      await expect.poll(async () => (await blurStats(a)).on, { timeout: 30_000 }).toBe(true);
      await a.waitForTimeout(4_000);
      const samples: number[] = [];
      for (let i = 0; i < 10; i++) {
        await a.waitForTimeout(1_000);
        samples.push((await blurStats(a)).fps);
      }
      test.info().annotations.push({ type: 'blur-fps', description: samples.join(',') });
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(24);
      // Bob still receives Alice's (blurred) video.
      const before = (await stats(b))[0]!.videoFrames;
      await expect
        .poll(async () => (await stats(b))[0]!.videoFrames, { timeout: 5_000 })
        .toBeGreaterThan(before + 20);
      // A PC that cannot keep up: blur turns itself off and says so.
      await a.evaluate(() => {
        (window as unknown as TestWindow).__officemeshBlurDelayMs = 80;
      });
      await expect(a.getByTestId('call-message')).toContainText('Background blur turned off', {
        timeout: 20_000,
      });
      expect((await blurStats(a)).on).toBe(false);
      await a.evaluate(() => {
        (window as unknown as TestWindow).__officemeshBlurDelayMs = 0;
      });

      // --- Recording: the banner is on every screen for the whole recording.
      await a.getByTestId('call-more').click();
      await a.getByTestId('call-record').click();
      for (const p of [a, b])
        await expect(p.getByTestId('recording-banner')).toBeVisible({ timeout: 5_000 });
      let gaps = 0;
      for (let i = 0; i < 24; i++) {
        await a.waitForTimeout(250);
        for (const p of [a, b]) if (!(await p.getByTestId('recording-banner').isVisible())) gaps++;
      }
      expect(gaps).toBe(0);
      await a.getByTestId('call-more').click();
      await a.getByTestId('call-record').click();
      for (const p of [a, b])
        await expect(p.getByTestId('recording-banner')).toBeHidden({ timeout: 10_000 });

      // The recording lands in the meeting chat as an MP4 that decodes.
      await a.getByTestId('call-chat').click();
      const video = a.getByTestId('meeting-chat').getByTestId('inline-video');
      await expect(video).toBeVisible({ timeout: 20_000 });
      const media = await video.evaluate(async (el: HTMLVideoElement) => {
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 50 && el.readyState < 1; i++) await wait(100);
        el.muted = true;
        await Promise.race([el.play().catch(() => {}), wait(3_000)]);
        await wait(1_500);
        const q = el.getVideoPlaybackQuality();
        return {
          readyState: el.readyState,
          networkState: el.networkState,
          error: el.error?.code ?? 0,
          duration: el.duration,
          width: el.videoWidth,
          height: el.videoHeight,
          frames: q.totalVideoFrames,
          src: el.src,
        };
      });
      test.info().annotations.push({ type: 'recording', description: JSON.stringify(media) });
      expect(media.width).toBe(1280);
      expect(media.height).toBe(720);
      expect(media.frames).toBeGreaterThan(5);
      // The file on disk is an MP4 (ftyp box), which Windows Media Player plays.
      const sha = /files\/([0-9a-f]{64})/.exec(media.src)![1]!;
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const head = readFileSync(join(roots[0]!.path, 'files', sha))
        .subarray(4, 8)
        .toString('latin1');
      expect(head).toBe('ftyp');
    } finally {
      await close();
    }
  });
});

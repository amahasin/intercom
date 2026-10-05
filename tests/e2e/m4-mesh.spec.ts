import { expect, test, type Page } from '@playwright/test';
import { lanArgs, launchApp, randomPort, tempDataRoot, type RunningApp } from './app.ts';

/**
 * Plan M4: an 8-person mesh video call runs 30 minutes without a dropped participant.
 * `pnpm e2e` runs it for 1 minute; set OFFICEMESH_MESH_MINUTES=30 for the full check.
 */
const MINUTES = Number(process.env['OFFICEMESH_MESH_MINUTES'] ?? '1');
const PEOPLE = 8;

interface PeerStats {
  state: string;
  audioPackets: number;
  videoFrames: number;
}
type StatsWindow = { officemeshCallStats: () => Promise<PeerStats[]> };
const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as StatsWindow).officemeshCallStats());

test(`8-person mesh video call stays whole for ${MINUTES} minute(s)`, async () => {
  test.setTimeout((MINUTES * 60 + 240) * 1_000);
  const names = Array.from({ length: PEOPLE }, (_, i) => `mesh${i}`);
  const roots = names.map(() => tempDataRoot());
  const port = randomPort();
  const apps: RunningApp[] = await Promise.all(
    names.map((n, i) => launchApp(n, roots[i]!.path, [...lanArgs(port), '--fake-media'])),
  );
  const pages = apps.map((a) => a.window);
  try {
    const ids = await Promise.all(
      pages.map(async (p) => {
        await expect(p.getByTestId('user-id')).toHaveText(/^[a-z2-7]{32}$/);
        return (await p.getByTestId('user-id').textContent())!;
      }),
    );
    const host = pages[0]!;
    for (const id of ids.slice(1)) {
      await expect(host.getByTestId(`person-${id}`)).toHaveAttribute('data-online', 'true', {
        timeout: 30_000,
      });
    }
    await host.getByTestId('new-group').click();
    for (const id of ids.slice(1)) await host.getByTestId(`pick-${id}`).click();
    await host.getByTestId('group-create').click();
    await expect(host.getByTestId('header-presence')).toContainText(`${PEOPLE} people`);
    await host.getByTestId('start-video-call').click();
    await Promise.all(
      pages.slice(1).map((p) => p.getByTestId('call-accept-video').click({ timeout: 30_000 })),
    );

    const connected = async (p: Page) =>
      (await stats(p)).filter((s) => s.state === 'connected').length;
    for (const p of pages) {
      await expect.poll(() => connected(p), { timeout: 60_000 }).toBe(PEOPLE - 1);
    }
    for (const p of pages) await expect(p.getByTestId('call-tile')).toHaveCount(PEOPLE);

    // Hold the call; every 15 s each PC must still be connected to all 7 others and hearing them.
    const audio = async (p: Page) => (await stats(p)).reduce((n, s) => n + s.audioPackets, 0);
    let last = await Promise.all(pages.map(audio));
    const end = Date.now() + MINUTES * 60_000;
    let checks = 0;
    while (Date.now() < end) {
      await host.waitForTimeout(Math.min(15_000, Math.max(1_000, end - Date.now())));
      const now = await Promise.all(pages.map(audio));
      for (const [i, p] of pages.entries()) {
        expect(await connected(p), `${names[i]} lost a participant`).toBe(PEOPLE - 1);
        expect(await p.getByTestId('call-tile').count()).toBe(PEOPLE);
        expect(now[i]!, `${names[i]} stopped receiving audio`).toBeGreaterThan(last[i]!);
      }
      last = now;
      checks++;
    }
    // Above 6 people only the 4 most recent speakers send video, so each PC decodes some video.
    const frames = await Promise.all(
      pages.map(async (p) => (await stats(p)).reduce((n, s) => n + s.videoFrames, 0)),
    );
    test.info().annotations.push({ type: 'checks', description: String(checks) });
    test.info().annotations.push({ type: 'video-frames-per-pc', description: frames.join(',') });
    for (const f of frames) expect(f).toBeGreaterThan(0);
  } finally {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  }
});

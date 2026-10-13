import { mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
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
  return { apps, ids, roots, close };
}

const width = async (p: Page, testId: string) => (await p.getByTestId(testId).boundingBox())!.width;

/** Drag a vertical resize handle by `dx` pixels. */
async function drag(p: Page, testId: string, dx: number) {
  const box = (await p.getByTestId(testId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x + dx / 2, y, { steps: 4 });
  await p.mouse.move(x + dx, y, { steps: 4 });
  await p.mouse.up();
}

test.describe('M6.6', () => {
  test('the call window: controls along the top, tiles that fit, a resizable people/chat panel with a chat toolbar that fits', async () => {
    test.setTimeout(180_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    const [alice, bob, carol] = apps as [RunningApp, RunningApp, RunningApp];
    try {
      const m = alice.window;
      await m.getByTestId('new-group').click();
      await m.getByTestId('group-title').fill('Standup');
      await m.getByTestId(`pick-${ids[1]}`).click();
      await m.getByTestId(`pick-${ids[2]}`).click();
      await m.getByTestId('group-create').click();
      await m.getByTestId('start-video-call').click();
      for (const x of [bob, carol])
        await (await windowWithRole(x.app, 'incoming')).getByTestId('call-accept-video').click();
      const a = await windowWithRole(alice.app, 'call');
      await expect(a.getByTestId('call-tile')).toHaveCount(3, { timeout: 30_000 });

      // Controls are in a bar along the top; every control is reachable.
      const bar = (await a.getByTestId('call-toolbar').boundingBox())!;
      expect(bar.y).toBeLessThan(80);
      for (const id of [
        'call-chat',
        'call-people',
        'call-hand',
        'call-react',
        'call-layout',
        'call-more',
        'call-camera',
        'call-mute',
        'call-share',
        'call-hangup',
      ]) {
        const box = (await a.getByTestId(id).boundingBox())!;
        expect(box.y, id).toBeGreaterThanOrEqual(bar.y - 1);
        expect(box.y + box.height, id).toBeLessThanOrEqual(bar.y + bar.height + 1);
      }
      await a.screenshot({ path: `${SHOTS}/e2e-call-toolbar.png` });

      // The people tiles stay inside the window, below the bar.
      const view = await a.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      for (const tile of await a.getByTestId('call-tile').all()) {
        const box = (await tile.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(view.height + 1);
        expect(box.x + box.width).toBeLessThanOrEqual(view.width + 1);
      }

      // People panel: opens, lists everyone, and its edge can be dragged.
      await a.getByTestId('call-people').click();
      await expect(a.getByTestId('people-row')).toHaveCount(3);
      const before = await width(a, 'call-side-panel');
      await drag(a, 'call-panel-resize', -120);
      const wider = await width(a, 'call-side-panel');
      expect(wider).toBeGreaterThan(before + 60);
      await drag(a, 'call-panel-resize', 60);
      expect(await width(a, 'call-side-panel')).toBeLessThan(wider - 30);

      // The meeting chat takes its place; its formatting buttons stay inside it.
      await a.getByTestId('call-chat').click();
      await expect(a.getByTestId('meeting-chat')).toBeVisible();
      await expect(a.getByTestId('people-panel')).toHaveCount(0);
      await drag(a, 'call-panel-resize', 200); // as narrow as it goes
      const panel = (await a.getByTestId('call-side-panel').boundingBox())!;
      const tools = await a
        .getByRole('toolbar', { name: /format/i })
        .first()
        .boundingBox();
      if (tools) expect(tools.x + tools.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      for (const btn of await a.getByTestId('meeting-chat').getByRole('button').all()) {
        const box = await btn.boundingBox();
        if (box) expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 2);
      }
      await a.screenshot({ path: `${SHOTS}/e2e-call-chat-panel.png` });

      // The microphone's menu has the noise suppression levels.
      await a.getByTestId('call-mic-menu').click();
      await a.getByRole('menuitem', { name: /noise suppression/i }).click();
      await a.getByTestId('noise-standard').click();
      await expect(a.getByTestId('call-tile')).toHaveCount(3);
      await a.getByTestId('call-hangup').click();
    } finally {
      await close();
    }
  });

  test('the list pane can be resized and remembers; the "drop files" cover never stays behind; files arrive by themselves unless that is turned off', async () => {
    test.setTimeout(150_000);
    const { apps, ids, roots, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    const a = alice.window;
    const b = bob.window;
    try {
      // Resizing the list: wider, then back by a double click.
      const base = await width(a, 'list-pane');
      await drag(a, 'list-resize', 90);
      expect(await width(a, 'list-pane')).toBeGreaterThan(base + 50);
      await drag(a, 'list-resize', -400); // clamped
      expect(await width(a, 'list-pane')).toBeGreaterThanOrEqual(240);
      await a.getByTestId('list-resize').dblclick();
      expect(Math.abs((await width(a, 'list-pane')) - 320)).toBeLessThan(3);

      // A drag that starts over the chat and is then called off leaves no cover behind.
      await clickPerson(a, ids[1]);
      await expect(a.getByTestId('conversation')).toBeVisible();
      const over = (kind: string) =>
        a.evaluate((type) => {
          const el = document.querySelector('[data-testid="conversation"]')!;
          const dt = new DataTransfer();
          dt.items.add(new File(['x'], 'x.txt'));
          el.dispatchEvent(
            new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
          );
        }, kind);
      await over('dragover');
      await expect(a.getByText('Drop files to share them')).toBeVisible();
      // Nothing more is reported (Escape, or the drag went elsewhere): the cover goes by itself.
      await expect(a.getByText('Drop files to share them')).toBeHidden({ timeout: 3_000 });
      await over('dragover');
      await expect(a.getByText('Drop files to share them')).toBeVisible();
      await a.evaluate(() => window.dispatchEvent(new Event('dragend')));
      await expect(a.getByText('Drop files to share them')).toBeHidden({ timeout: 1_000 });

      // Files arrive by themselves.
      await b.getByTestId('rail-chat').click();
      const file = join(roots[0]!.path, 'minutes.bin');
      const fd = openSync(file, 'w');
      writeSync(fd, Buffer.alloc(3 * 1024 * 1024, 7));
      closeSync(fd);
      await a.getByTestId('file-input').setInputFiles(file);
      await a.getByTestId('composer').click();
      await a.getByTestId('composer').press('Enter');
      await b.getByTestId(`conv-${ids[0]}`).click();
      await expect(b.getByTestId('file-card')).toHaveAttribute('data-state', 'complete', {
        timeout: 30_000,
      });
      await expect(b.getByTestId('file-download')).toHaveCount(0);

      // Turned off in Settings > Files: the next one waits for a click.
      await b.getByTestId('me-avatar').click();
      await b.getByTestId('open-settings').click();
      await b.getByTestId('settings-tab-files').click();
      await expect(b.getByTestId('setting-auto-receive')).toBeVisible();
      await b.getByTestId('setting-auto-receive').click();
      await b.getByTestId('settings-close').click();
      const file2 = join(roots[0]!.path, 'minutes-2.bin');
      const fd2 = openSync(file2, 'w');
      writeSync(fd2, Buffer.alloc(2 * 1024 * 1024, 9));
      closeSync(fd2);
      await a.getByTestId('file-input').setInputFiles(file2);
      await a.getByTestId('composer').click();
      await a.getByTestId('composer').press('Enter');
      await expect(b.getByTestId('file-card')).toHaveCount(2, { timeout: 15_000 });
      await expect(b.getByTestId('file-card').last()).toHaveAttribute('data-state', 'missing');
      await expect(b.getByTestId('file-download')).toHaveCount(1);
      await b.screenshot({ path: `${SHOTS}/e2e-files-manual.png` });
    } finally {
      await close();
    }
  });

  test('noise suppression is a setting (high by default)', async () => {
    test.setTimeout(60_000);
    const { apps, close } = await office(['alice']);
    const a = apps[0]!.window;
    try {
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('open-settings').click();
      await a.getByTestId('settings-tab-calls').click();
      await expect(a.getByTestId('noise-high')).toBeChecked();
      await a.getByTestId('noise-off').click();
      await expect(a.getByTestId('noise-off')).toBeChecked();
      await a.getByTestId('noise-high').click();
      await expect(a.getByTestId('noise-high')).toBeChecked();
    } finally {
      await close();
    }
  });
});

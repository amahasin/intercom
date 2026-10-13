import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  clickPerson,
  expectPerson,
  lanArgs,
  launchApp,
  randomPort,
  tempDataRoot,
  type RunningApp,
  windowWithRole,
  windowCount,
} from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;
const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

/** Apps on one private loopback LAN, each knowing all the others (own data folder each). */
async function office(names: string[], width?: number) {
  const roots = names.map(() => tempDataRoot());
  const port = randomPort();
  const apps = await Promise.all(
    names.map((n, i) => launchApp(n, roots[i]!.path, [...lanArgs(port), '--fake-media'])),
  );
  if (width)
    await Promise.all(
      apps.map((a) =>
        a.app.evaluate(({ BrowserWindow }, w) => {
          const win = BrowserWindow.getAllWindows()[0]!;
          win.setSize(w, 1000);
        }, width),
      ),
    );
  const ids = await Promise.all(apps.map(userIdOf));
  for (const [i, app] of apps.entries())
    for (const [j, id] of ids.entries())
      if (i !== j)
        await expectPerson(app.window, id).toHaveAttribute('data-online', 'true', {
          timeout: 15_000,
        });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps, ids, roots, close };
}

/** A small gradient PNG. */
function png(path: string, w: number, h: number): void {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((x / w) * 255);
      raw[o + 1] = Math.round((y / h) * 200);
      raw[o + 2] = 160;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', head),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function bytesIn(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0);
}

const sounds = (p: Page) =>
  p.evaluate(() => [
    ...((window as unknown as { officemeshSounds: string[] }).officemeshSounds ?? []),
  ]);

async function openChat(page: Page, userId: string) {
  await clickPerson(page, userId);
  await expect(page.getByTestId('composer')).toBeVisible();
}

test.describe('M6.1 fixes', () => {
  test('attaching only queues a file; Send sends it with the message; nothing is copied', async () => {
    test.setTimeout(180_000);
    const { apps, ids, roots, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    const a = alice.window;
    const b = bob.window;
    try {
      const pic = join(roots[0]!.path, 'floor-plan.png');
      png(pic, 640, 400);
      const big = join(roots[0]!.path, 'Quarterly figures.bin');
      const fd = openSync(big, 'w');
      ftruncateSync(fd, 1024 * 1024 * 1024);
      closeSync(fd);
      await openChat(a, ids[1]!);
      await a.getByTestId('file-input').setInputFiles([pic, big]);
      // They wait in the composer, with a picture preview; Bob sees nothing yet.
      await expect(a.getByTestId('attachment')).toHaveCount(2);
      await expect(a.getByTestId('attachment-preview')).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-attachments.png` });
      await b.waitForTimeout(1_500);
      await clickPerson(b, ids[0]);
      await expect(b.getByTestId('message')).toHaveCount(0);
      // A queued file can be taken out again.
      await a.getByTestId('attachment-remove').first().click();
      await expect(a.getByTestId('attachment')).toHaveCount(1);
      await a.getByTestId('file-input').setInputFiles([pic]);
      await expect(a.getByTestId('attachment')).toHaveCount(2);

      // Typing a message and pressing Enter sends the message and the files together.
      await a.getByTestId('composer').click();
      await a.keyboard.type('Plan and figures, please check');
      await a.getByTestId('composer').press('Enter');
      // The composer is free at once and the files are in the chat straight away: nothing is read
      // first, so even the 1 GB file is a message within moments, and nothing is shown twice.
      await expect(a.getByTestId('attachment')).toHaveCount(0);
      await expect(a.getByTestId('pending-send')).toHaveCount(0, { timeout: 15_000 });
      await expect(a.getByTestId('message').filter({ hasText: 'Plan and figures' })).toHaveCount(1);
      await expect(a.getByTestId('inline-image')).toBeVisible();
      await expect(a.getByTestId('file-card')).toHaveAttribute('data-state', 'complete');
      // Alice's app stored no copy of the 1 GB file (and made no fingerprint of it either).
      expect(bytesIn(join(roots[0]!.path, 'files'))).toBeLessThan(5 * 1024 * 1024);

      // On Bob's PC both arrive by themselves, with no click: the picture shows inline and the
      // big file starts downloading into his folder.
      await expect(b.getByTestId('inline-image')).toHaveAttribute('data-state', 'complete', {
        timeout: 30_000,
      });
      // While it goes: percentage, speed and time left on Bob's card, and who it is being
      // sent to (with the same figures) on Alice's.
      await expect(b.getByTestId('file-progress')).toContainText(/\d+%/, { timeout: 30_000 });
      await expect(b.getByTestId('file-progress')).toContainText('/s', { timeout: 30_000 });
      await expect(a.getByTestId('file-upload').first()).toBeVisible({ timeout: 30_000 });
      await expect(a.getByTestId('file-upload').first()).toContainText('Sending to');
      await expect(a.getByTestId('file-upload').first()).toContainText('%');
      await b.screenshot({ path: `${SHOTS}/e2e-download-progress.png` });
      await a.screenshot({ path: `${SHOTS}/e2e-upload-progress.png` });
      await expect(b.getByTestId('file-card')).toHaveAttribute('data-state', 'complete', {
        timeout: 120_000,
      });
      const saved = join(roots[1]!.path, 'downloads', 'InterCom', 'Quarterly figures.bin');
      expect(statSync(saved).size).toBe(1024 * 1024 * 1024);
      await expect(a.getByTestId('file-upload')).toHaveCount(0, { timeout: 15_000 });

      // Alice deletes her original: her card says so, and Bob's copy is unaffected.
      rmSync(big);
      await expect(a.getByTestId('file-missing')).toHaveText('File is missing', {
        timeout: 15_000,
      });
      await a.screenshot({ path: `${SHOTS}/e2e-sender-missing.png` });
      await expect(b.getByTestId('file-card')).toHaveAttribute('data-state', 'complete');
      // Bob deletes his: his says so too, and he cannot get it again (Alice's is gone).
      rmSync(saved);
      await expect(b.getByTestId('file-missing')).toHaveText('File is missing', {
        timeout: 15_000,
      });
      await b.screenshot({ path: `${SHOTS}/e2e-receiver-missing.png` });
    } finally {
      await close();
    }
  });

  test('a file that cannot be read stays in the chat as "Not sent", with Try again and Remove', async () => {
    test.setTimeout(120_000);
    const { apps, ids, roots, close } = await office(['alice', 'bob']);
    const [alice] = apps as [RunningApp, RunningApp];
    const a = alice.window;
    try {
      const doomed = join(roots[0]!.path, 'gone-before-send.txt');
      writeFileSync(doomed, 'hello');
      await openChat(a, ids[1]!);
      await a.getByTestId('file-input').setInputFiles([doomed]);
      await expect(a.getByTestId('attachment')).toHaveCount(1);
      // The file disappears between attaching and sending.
      rmSync(doomed);
      await a.getByTestId('composer').click();
      await a.keyboard.type('here it is');
      await a.getByTestId('composer').press('Enter');
      await expect(a.getByTestId('attachment')).toHaveCount(0);
      const pending = a.getByTestId('pending-send');
      await expect(pending).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
      await expect(pending.getByTestId('pending-status')).toContainText('Not sent');
      await expect(pending).toContainText('here it is');
      // Put it back: Try again sends it and the placeholder gives way to the real message.
      writeFileSync(doomed, 'hello');
      await pending.getByTestId('pending-retry').click();
      await expect(a.getByTestId('pending-send')).toHaveCount(0, { timeout: 30_000 });
      await expect(a.getByTestId('message').filter({ hasText: 'here it is' })).toHaveCount(1);
      // And a failed one can simply be removed.
      const second = join(roots[0]!.path, 'gone-too.txt');
      writeFileSync(second, 'x');
      await a.getByTestId('file-input').setInputFiles([second]);
      rmSync(second);
      await a.getByTestId('composer').click();
      await a.keyboard.type('x');
      await a.getByTestId('composer').press('Enter');
      await expect(a.getByTestId('pending-send')).toHaveAttribute('data-state', 'failed', {
        timeout: 15_000,
      });
      await a.getByTestId('pending-dismiss').click();
      await expect(a.getByTestId('pending-send')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('a ringing call has a tune, and every call ends with a sound and a message', async () => {
    test.setTimeout(180_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [alice, bob] = apps as [RunningApp, RunningApp];
    const a = alice.window;
    try {
      // Calls ring in a small window of their own and run in a call window each: the sounds
      // are logged per window.
      // Answered, then ended.
      await openChat(a, ids[1]!);
      await a.getByTestId('start-audio-call').click();
      const ring = await windowWithRole(bob.app, 'incoming');
      const aCall = await windowWithRole(alice.app, 'call');
      await expect(ring.getByTestId('incoming-call')).toBeVisible();
      await expect.poll(() => sounds(aCall)).toContain('start:ringback');
      await expect.poll(() => sounds(ring)).toContain('start:ringtone');
      await ring.getByTestId('call-accept-audio').click();
      const bCall = await windowWithRole(bob.app, 'call');
      await expect(aCall.getByTestId('call-stage')).toBeVisible();
      await expect.poll(() => sounds(aCall)).toContain('stop:ringback');
      await expect.poll(() => sounds(aCall)).toContain('play:connected');
      await aCall.waitForTimeout(1_500);
      await aCall.getByTestId('call-hangup').click();
      // The call window stays a moment with "Call ended", with a sound, then closes.
      await expect(aCall.getByTestId('call-ended')).toHaveAttribute('data-outcome', 'completed');
      await expect(aCall.getByTestId('call-ended-title')).toHaveText('Call ended');
      await aCall.screenshot({ path: `${SHOTS}/e2e-call-ended.png` });
      await expect.poll(() => sounds(aCall)).toContain('play:ended');
      await expect(bCall.getByTestId('call-ended-title')).toHaveText('Call ended');
      await expect.poll(() => sounds(bCall)).toContain('play:ended');
      await expect.poll(() => windowCount(alice.app, 'call'), { timeout: 10_000 }).toBe(0);
      await expect.poll(() => windowCount(bob.app, 'call'), { timeout: 10_000 }).toBe(0);

      // Cancelled before it was answered: a missed call for Bob, in the ring window.
      await a.getByTestId('start-audio-call').click();
      const ring2 = await windowWithRole(bob.app, 'incoming');
      const aCall2 = await windowWithRole(alice.app, 'call');
      await expect(ring2.getByTestId('incoming-call')).toBeVisible();
      await aCall2.getByTestId('call-hangup').click();
      await expect(ring2.getByTestId('call-ended')).toHaveAttribute('data-outcome', 'missed');
      await expect(ring2.getByTestId('call-ended-title')).toHaveText('Call missed');
      await ring2.screenshot({ path: `${SHOTS}/e2e-call-missed.png` });
      await expect.poll(() => sounds(ring2)).toContain('play:missed');
      await expect(aCall2.getByTestId('call-ended-title')).toBeVisible();
      await expect.poll(() => windowCount(bob.app, 'incoming'), { timeout: 10_000 }).toBe(0);
      await expect.poll(() => windowCount(alice.app, 'call'), { timeout: 10_000 }).toBe(0);

      // Declined: Alice is told, and the ring window says so too.
      await a.getByTestId('start-audio-call').click();
      const ring3 = await windowWithRole(bob.app, 'incoming');
      const aCall3 = await windowWithRole(alice.app, 'call');
      await expect(ring3.getByTestId('incoming-call')).toBeVisible();
      await ring3.getByTestId('call-decline').click();
      await expect(aCall3.getByTestId('call-ended')).toHaveAttribute('data-outcome', 'declined');
      await expect(aCall3.getByTestId('call-ended-title')).toHaveText('Call declined');
      await expect(aCall3.getByTestId('call-ended-detail')).toContainText('declined');
      await expect.poll(() => sounds(aCall3)).toContain('play:declined');
      await expect.poll(() => sounds(ring3)).toContain('play:declined');
    } finally {
      await close();
    }
  });

  test('settings has categories, profile editing moved in, and status dots in the menu', async () => {
    test.setTimeout(90_000);
    const { apps, close } = await office(['alice']);
    const a = apps[0]!.window;
    try {
      await a.getByTestId('me-avatar').click();
      // A dot for each status, in its own colour.
      for (const state of ['available', 'busy', 'dnd', 'brb', 'away'])
        await expect(
          a.getByTestId(`presence-${state}`).getByTestId('presence-dot'),
        ).toHaveAttribute('data-presence', state);
      await a.getByTestId('edit-profile').click();
      // "Edit profile" opens Settings on the Profile category.
      await expect(a.getByTestId('settings-title')).toHaveText('Profile');
      await expect(a.getByTestId('settings-pane-profile')).toBeVisible();
      await a.getByTestId('profile-name-input').fill('Alice Renamed');
      await a.getByTestId('profile-status-input').fill('Heads down until 3');
      await a.getByTestId('profile-save').click();
      await expect(a.getByTestId('profile-saved')).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-settings-profile.png` });

      for (const [id, title] of [
        ['general', 'General'],
        ['calls', 'Calls and devices'],
        ['files', 'Files'],
        ['network', 'Network'],
        ['backup', 'Backup and move'],
        ['updates', 'Updates'],
        ['diagnostics', 'Diagnostics'],
        ['about', 'About'],
      ] as const) {
        await a.getByTestId(`settings-tab-${id}`).click();
        await expect(a.getByTestId('settings-title')).toHaveText(title);
        await expect(a.getByTestId(`settings-pane-${id}`)).toBeVisible();
      }
      // Updates: a button asks now (this unpackaged build has nothing to ask, and says so).
      await a.getByTestId('settings-tab-updates').click();
      await a.getByTestId('check-for-updates').click();
      await expect(a.getByTestId('update-status')).toHaveText('Update checks are off.');
      // About: the project's page on GitHub, opened by the browser (not loaded in the app).
      await a.getByTestId('settings-tab-about').click();
      await expect(a.getByTestId('about-repository')).toHaveAttribute(
        'href',
        'https://github.com/amahasin/intercom',
      );
      // The folder files are saved to: the default is in Downloads\OfficeMesh.
      await a.getByTestId('settings-tab-files').click();
      await expect(a.getByTestId('save-folder')).toHaveValue(/InterCom$/);
      await a.getByTestId('settings-close').click();
      await expect(a.getByTestId('settings-title')).toHaveCount(0);
      // The change reached the title bar.
      await a.getByTestId('me-avatar').click();
      await expect(a.getByTestId('display-name')).toHaveText('Alice Renamed');
    } finally {
      await close();
    }
  });

  test('the calendar: pick a time slot to schedule, right-click, views, filter, date picker', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const a = apps[0]!.window;
    try {
      await a.getByTestId('rail-calendar').click();
      await expect(a.getByTestId('mini-month')).toBeVisible();
      await a.getByRole('button', { name: 'Choose a date' }).waitFor();
      await a.getByTestId('calendar-view-menu').click();
      await a.getByTestId('calendar-view-week').click();
      await expect(a.getByTestId('calendar-column')).toHaveCount(7);
      await expect(a.getByTestId('now-line')).toBeVisible();
      await expect(
        a.getByTestId('calendar-day-head').and(a.locator('[data-today="true"]')),
      ).toHaveCount(1);

      // Drag across the time slots of a day: the schedule dialog opens with that time.
      const scroller = a.getByTestId('calendar-scroller');
      const sb = (await scroller.boundingBox())!;
      const column = a.getByTestId('calendar-column').nth(2);
      const cb = (await column.boundingBox())!;
      const x = cb.x + cb.width / 2;
      const y0 = sb.y + 200;
      await a.mouse.move(x, y0);
      await a.mouse.down();
      await a.mouse.move(x, y0 + 100, { steps: 8 });
      await expect(a.getByTestId('calendar-selection')).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-calendar-drag.png` });
      await a.mouse.up();
      await expect(a.getByTestId('meeting-title')).toBeVisible();
      const start = await a.getByTestId('meeting-start').inputValue();
      const end = await a.getByTestId('meeting-end').inputValue();
      expect(start).toMatch(/^\d\d:(00|30)$/);
      expect(end > start).toBe(true);
      await a.screenshot({ path: `${SHOTS}/e2e-calendar-new-from-slot.png` });
      await a.getByTestId('meeting-title').fill('Slot meeting');
      await a.getByTestId(`pick-${ids[1]}`).click();
      await a.getByTestId('meeting-schedule').click();
      await expect(
        a.locator('[data-testid="calendar-event"][data-title="Slot meeting"]'),
      ).toBeVisible({ timeout: 10_000 });

      // Right-click a slot: "New meeting" opens the dialog at that slot.
      await a.mouse.click(x, y0 - 120, { button: 'right' });
      await expect(a.getByTestId('calendar-ctx-new')).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-calendar-context.png` });
      await a.getByTestId('calendar-ctx-new').click();
      await expect(a.getByTestId('meeting-title')).toBeVisible();
      await a.keyboard.press('Escape');
      await expect(a.getByTestId('meeting-title')).toHaveCount(0);

      // Double-click a slot opens it too.
      await a.mouse.dblclick(x, y0 - 60);
      await expect(a.getByTestId('meeting-title')).toBeVisible();
      await a.keyboard.press('Escape');

      // Filters: I organise it, so it stays; "waiting for my reply" hides it.
      await a.getByTestId('calendar-filter-menu').click();
      await a.getByTestId('calendar-filter-pending').click();
      await expect(a.getByTestId('calendar-filter-menu')).toHaveText('Filter applied');
      await expect(
        a.locator('[data-testid="calendar-event"][data-title="Slot meeting"]'),
      ).toHaveCount(0);
      await a.getByTestId('calendar-filter-menu').click();
      await a.getByTestId('calendar-filter-organizer').click();
      await expect(
        a.locator('[data-testid="calendar-event"][data-title="Slot meeting"]'),
      ).toBeVisible();
      await a.getByTestId('calendar-filter-menu').click();
      await a.getByTestId('calendar-filter-all').click();
      await expect(a.getByTestId('calendar-filter-menu')).toHaveText('Filter');

      // Month view, then back; Today, previous and next; the date picker.
      await a.getByTestId('calendar-view-menu').click();
      await a.getByTestId('calendar-view-month').click();
      await expect(a.getByTestId('calendar-month')).toBeVisible();
      await expect(a.getByTestId('calendar-month-cell')).toHaveCount(42);
      await expect(
        a.locator('[data-testid="calendar-event"][data-title="Slot meeting"]'),
      ).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-calendar-month.png` });
      const label = await a.getByTestId('calendar-range').textContent();
      await a.getByTestId('calendar-next').click();
      expect(await a.getByTestId('calendar-range').textContent()).not.toBe(label);
      await a.getByTestId('calendar-today').click();
      expect(await a.getByTestId('calendar-range').textContent()).toBe(label);
      await a.getByTestId('calendar-view-menu').click();
      await a.getByTestId('calendar-view-day').click();
      await expect(a.getByTestId('calendar-column')).toHaveCount(1);
      await a.getByTestId('mini-day').nth(10).click();
      expect(await a.getByTestId('calendar-range').textContent()).not.toBe(label);
      // Hide the date picker pane and bring it back.
      await a.getByTestId('calendar-sidebar-toggle').click();
      await expect(a.getByTestId('mini-month')).toHaveCount(0);
      await a.getByTestId('calendar-sidebar-toggle').click();
      await expect(a.getByTestId('mini-month')).toBeVisible();
    } finally {
      await close();
    }
  });

  test('chats are at most 960 px wide; each rail shows its own thing', async () => {
    test.setTimeout(90_000);
    const { apps, ids, close } = await office(['alice', 'bob'], 1800);
    const a = apps[0]!.window;
    try {
      await openChat(a, ids[1]!);
      await a.getByTestId('composer').click();
      await a.keyboard.type('hello');
      await a.getByTestId('composer').press('Enter');
      await expect(a.getByTestId('message')).toHaveCount(1);
      const box = (await a.getByTestId('composer-box').boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(960);
      expect(box.width).toBeGreaterThan(700);
      const list = (await a.getByTestId('message-list').boundingBox())!;
      // Centred in the space beside the list pane.
      const left = box.x - list.x;
      const right = list.x + list.width - (box.x + box.width);
      expect(Math.abs(left - right)).toBeLessThan(40);
      expect(left).toBeGreaterThan(100);
      await a.screenshot({ path: `${SHOTS}/e2e-wide-chat.png` });

      // The Teams rail does not show the open chat; Calls and Activity say what they are.
      await a.getByTestId('rail-teams').click();
      await expect(a.getByTestId('conversation')).toHaveCount(0);
      await expect(a.getByTestId('empty-pane')).toHaveAttribute('data-rail', 'teams');
      await a.getByTestId('rail-calls').click();
      await expect(a.getByTestId('empty-pane')).toHaveAttribute('data-rail', 'calls');
      await a.getByTestId('rail-files').click();
      await expect(a.getByTestId('files-view')).toBeVisible();
      await a.getByTestId('rail-chat').click();
      await expect(a.getByTestId('conversation')).toBeVisible();
    } finally {
      await close();
    }
  });
});

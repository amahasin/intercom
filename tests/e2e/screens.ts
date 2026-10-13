/**
 * Screenshots of the main views of the real app, for looking at (not an assertion test):
 *
 *   node tests/e2e/screens.ts [--out=test-results/screens] [--width=1440] [--height=900]
 *
 * Starts a few simulated colleagues, creates sample chats, files and meetings, and saves a
 * PNG of each view. Look at them side by side to spot views that do not match each other.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { _electron as electron, type Page } from '@playwright/test';
import { appDir, electronPath, lanArgs, randomPort, tempDataRoot } from './app.ts';

interface ProcessSim {
  peers: Array<{ identity: { userId: string; displayName: string } }>;
  act(index: number, action: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
}
const simModule = '@officemesh/sim';
const { startProcessPeers } = (await import(simModule)) as {
  startProcessPeers(o: {
    count: number;
    discoveryPort: number;
    loopbackOnly: boolean;
    echo?: boolean;
  }): Promise<ProcessSim>;
};

const arg = (name: string, def: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const OUT = arg('out', 'test-results/screens');
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
mkdirSync(OUT, { recursive: true });

/** A small gradient PNG, so a picture can be attached without a real file. */
function png(path: string, w: number, h: number): void {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((x / w) * 255);
      raw[o + 1] = Math.round((y / h) * 200);
      raw[o + 2] = 160;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
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

async function invoke<T>(page: Page, name: string, args: unknown): Promise<T> {
  return page.evaluate(
    ([name, args]) =>
      new Promise<unknown>((resolve, reject) => {
        const api = (
          window as unknown as {
            officemesh: {
              send(f: unknown): void;
              onFrame(
                l: (f: {
                  kind: string;
                  id?: number;
                  ok?: boolean;
                  result?: unknown;
                  error?: { message: string };
                }) => void,
              ): () => void;
            };
          }
        ).officemesh;
        const id = 1_000_000_000 + Math.floor(Math.random() * 1e9);
        const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 30_000);
        const off = api.onFrame((f) => {
          if (f.kind !== 'res' || f.id !== id) return;
          off();
          clearTimeout(timer);
          if (f.ok) resolve(f.result);
          else reject(new Error(f.error?.message ?? 'failed'));
        });
        api.send({ kind: 'req', id, name, args });
      }),
    [name, args] as const,
  ) as Promise<T>;
}

const THEME = arg('theme', 'system') as 'system' | 'light' | 'dark';
const root = tempDataRoot();
const port = randomPort();
const sim = await startProcessPeers({ count: 4, discoveryPort: port, loopbackOnly: true });
const app = await electron.launch({
  executablePath: electronPath,
  // No emulated colour scheme: the app's own Appearance setting (and Windows) decide.
  colorScheme: null,
  args: [
    appDir,
    '--profile=screens',
    `--data-root=${root.path}`,
    `--downloads-dir=${join(root.path, 'downloads')}`,
    ...lanArgs(port),
    '--fake-media',
  ],
});
const page = await app.firstWindow();
await app.evaluate(
  ({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setSize(w!, h!);
    win.center();
  },
  [WIDTH, HEIGHT],
);
const shot = async (name: string) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('saved', name);
};

try {
  const ids = sim.peers.map((p) => p.identity.userId);
  const me = await invoke<{ userId: string }>(page, 'identity.get', {});
  for (;;) {
    const people = await invoke<Array<{ online: boolean }>>(page, 'people.list', {});
    if (people.filter((p) => p.online).length >= sim.peers.length) break;
    await page.waitForTimeout(500);
  }
  if (THEME !== 'system') await invoke(page, 'settings.set', { theme: THEME });
  // Different presence states, so the dots show.
  await sim.act(0, { op: 'presence', state: 'busy' });
  await sim.act(1, { op: 'presence', state: 'away' });
  await sim.act(2, { op: 'presence', state: 'dnd' });

  // A direct chat with a few messages, a group and a team.
  const dm = await invoke<{ convId: string }>(page, 'conversations.openDirect', { userId: ids[0] });
  for (const text of [
    'Morning! Did the quarterly figures come through?',
    'Yes, I put them in the blue folder. **Please check page 3.**',
    'Will do. Can we meet at 10 to go through them?',
  ])
    await invoke(page, 'messages.send', { convId: dm.convId, text });
  const group = await invoke<{ convId: string }>(page, 'groups.create', {
    members: ids.slice(0, 3),
    title: 'Design crit',
  });
  await invoke(page, 'messages.send', { convId: group.convId, text: 'Kick-off notes are up.' });
  await invoke(page, 'teams.create', {
    name: 'Accounts',
    description: 'Month-end close',
    visibility: 'public',
    members: ids.slice(0, 2),
  }).catch(() => {});

  // Meetings: some overlapping, so the calendar has something to show.
  const day = new Date();
  const at = (d: number, h: number, m = 0) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate() + d, h, m).getTime();
  const schedule = (title: string, start: number, end: number, freq = 'none') =>
    invoke(page, 'meetings.schedule', {
      title,
      start,
      end,
      recurrence: { freq },
      convId: group.convId,
    });
  await schedule('Stand-up', at(0, 9, 30), at(0, 10), 'weekdays');
  await schedule('Design review', at(0, 11), at(0, 12, 30));
  await schedule('Budget sync', at(0, 11, 30), at(0, 12, 15));
  await schedule('1:1 with Asha', at(1, 14), at(1, 14, 30));
  await schedule('Retro', at(2, 16), at(2, 17));

  await page.waitForTimeout(1_500);
  // The colleagues answer, so the chat looks lived in.
  await sim.act(0, {
    op: 'dm',
    userId: me.userId,
    text: 'Morning! Yes, the figures are in the blue folder.',
  });
  await sim.act(0, { op: 'dm', userId: me.userId, text: 'Please check page 3 before we meet.' });
  await sim.act(1, {
    op: 'post',
    convId: group.convId,
    text: 'Thanks. I will review it this afternoon.',
  });
  await page.waitForTimeout(800);
  await page.getByTestId('chat-list').getByText('Asha Rahman').first().click();
  await shot('01-chat-dm');

  // Attach a picture and a document: they wait in the composer.
  const pic = join(root.path, 'floor-plan.png');
  const doc = join(root.path, 'Quarterly figures Q3.pdf');
  png(pic, 640, 400);
  writeFileSync(doc, Buffer.alloc(3_400_000, 7));
  await page.getByTestId('file-input').setInputFiles([pic, doc]);
  await page.getByTestId('composer').click();
  await page.keyboard.type('Here is the floor plan and the figures');
  await shot('02-chat-attachments');
  await page.getByTestId('send').click();
  await page.waitForTimeout(2_000);
  await shot('03-chat-file-sent');

  await page.getByTestId('rail-chat').click();
  await page.getByTestId('chat-list').getByText('Design crit').first().click();
  await shot('04-chat-group');

  await page.getByTestId('me-avatar').click();
  await shot('05-status-menu');
  await page.keyboard.press('Escape');

  for (const cat of [
    'profile',
    'general',
    'calls',
    'files',
    'network',
    'backup',
    'updates',
    'diagnostics',
    'about',
  ]) {
    if (cat === 'profile') {
      await page.getByTestId('me-avatar').click();
      await page.getByTestId('open-settings').click();
    }
    await page.getByTestId(`settings-tab-${cat}`).click();
    await page.waitForTimeout(600);
    await shot(`06-settings-${cat}`);
  }
  await page.getByTestId('settings-close').click();

  await page.getByTestId('rail-teams').click();
  await shot('07-teams');
  await page.getByTestId('rail-calls').click();
  await shot('08-calls');
  await page.getByTestId('rail-files').click();
  await shot('09-files');
  await page.getByTestId('rail-activity').click();
  await shot('10-activity');

  await page.getByTestId('rail-calendar').click();
  await shot('11-calendar-workweek');
  await page.getByTestId('calendar-view-menu').click();
  await page.getByTestId('calendar-view-week').click();
  await shot('12-calendar-week');
  const col = page.getByTestId('calendar-column').nth(3);
  const sb = (await page.getByTestId('calendar-scroller').boundingBox())!;
  const cb = (await col.boundingBox())!;
  const dragX = cb.x + cb.width / 2;
  await page.mouse.move(dragX, sb.y + 330);
  await page.mouse.down();
  await page.mouse.move(dragX, sb.y + 430, { steps: 6 });
  await shot('13-calendar-drag');
  await page.mouse.up();
  await shot('14-calendar-new-from-slot');
  await page.keyboard.press('Escape');
  await page.getByTestId('calendar-view-menu').click();
  await page.getByTestId('calendar-view-month').click();
  await shot('15-calendar-month');
  await page.getByTestId('calendar-view-menu').click();
  await page.getByTestId('calendar-view-day').click();
  await shot('16-calendar-day');
} finally {
  await app.close().catch(() => {});
  await sim.stop();
  root.dispose();
}

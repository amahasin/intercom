import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, test, type Locator } from '@playwright/test';
import {
  clickPerson,
  expectPerson,
  lanArgs,
  launchApp,
  randomPort,
  tempDataRoot,
  type RunningApp,
} from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;
const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

// A real 16 x 16 PNG (one colour) to give a group.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
function png(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = png(16);

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

/** Click a button of a message's bar the way a person does (the bar shows only over the bubble). */
async function clickBar(bubble: Locator, testId: string) {
  await bubble.hover();
  const box = (await bubble.getByTestId(testId).boundingBox())!;
  await bubble.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await bubble.getByTestId(testId).click();
}

const firstChat = (app: RunningApp) => app.window.locator('button[data-testid^="conv-"]').first();

test.describe('M6.10 follow-up', () => {
  test('people have their own rail; the chat title has one status dot and no status message', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await office(['alice', 'bob']);
    const [alice] = apps as [RunningApp, RunningApp];
    const a = alice.window;
    try {
      // Nobody is in the list of chats just for being on the network.
      await a.getByTestId('rail-chat').click();
      await expect(a.getByTestId(`person-${ids[1]!}`)).toHaveCount(0);
      await a.getByTestId('rail-people').click();
      await expect(a.getByTestId(`person-${ids[1]!}`)).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-people-rail.png` });

      // Picking someone opens the chat; its title has the person's dot on the avatar only.
      await clickPerson(a, ids[1]);
      await expect(a.getByTestId('composer')).toBeVisible();
      const header = a.getByTestId('conversation-header');
      await expect(header.locator('.fui-PresenceBadge')).toHaveCount(1);
      await expect(a.getByTestId('header-presence')).toHaveText('Available');
      await a.screenshot({ path: `${SHOTS}/e2e-chat-title.png` });
      // The chat is in the list of chats now.
      await a.getByTestId('rail-chat').click();
      await expect(a.getByTestId(`conv-${ids[1]!}`)).toBeVisible();
    } finally {
      await close();
    }
  });

  test('a group can have a picture, which every member sees', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    const [alice, bob] = apps as [RunningApp, RunningApp, RunningApp];
    const a = alice.window;
    const dir = mkdtempSync(join(tmpdir(), 'officemesh-e2e-pic-'));
    const file = join(dir, 'team.png');
    writeFileSync(file, PNG);
    try {
      await a.getByTestId('new-group').click();
      await a.getByTestId(`pick-${ids[1]!}`).click();
      await a.getByTestId(`pick-${ids[2]!}`).click();
      await a.getByTestId('group-create').click();
      await expect(a.getByTestId('header-presence')).toContainText('3 people');
      await expect(a.getByTestId('conversation-header').locator('img')).toHaveCount(0);

      // The picture is chosen with a file picker; the input behind the menu item takes the file.
      await a.getByTestId('group-picture-input').setInputFiles(file);
      await expect(a.getByTestId('conversation-header').locator('img')).toHaveAttribute(
        'src',
        /^data:image\/jpeg;base64,/,
        { timeout: 15_000 },
      );
      // Bob's list of chats shows it.
      await firstChat(bob).waitFor({ timeout: 20_000 });
      await expect(firstChat(bob).locator('img')).toHaveAttribute(
        'src',
        /^data:image\/jpeg;base64,/,
        { timeout: 20_000 },
      );
      await bob.window.screenshot({ path: `${SHOTS}/e2e-group-picture.png` });
    } finally {
      await close();
    }
  });

  test('forwarding: a preview, search, a choice of chats and people, and a note', async () => {
    test.setTimeout(150_000);
    const { apps, ids, close } = await office(['alice', 'bob', 'carol']);
    const [alice, , carol] = apps as [RunningApp, RunningApp, RunningApp];
    const a = alice.window;
    try {
      await clickPerson(a, ids[1]);
      await a.getByTestId('composer').click();
      await a.keyboard.type('the budget is approved');
      await a.getByTestId('composer').press('Enter');
      const bubble = a.getByTestId('message').filter({ hasText: 'the budget is approved' }).first();
      await expect(bubble).toBeVisible();
      await clickBar(bubble, 'action-more');
      await a.getByTestId('action-forward').click();

      const dialog = a.getByTestId('forward-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('forward-preview')).toContainText('the budget is approved');
      await expect(dialog.getByTestId('forward-send')).toBeDisabled();
      await a.screenshot({ path: `${SHOTS}/e2e-forward-dialog.png` });

      // Search narrows the list.
      await dialog.getByTestId('forward-search').fill('zzzz');
      await expect(dialog.getByTestId(`forward-to-${ids[2]!}`)).toHaveCount(0);
      await dialog.getByTestId('forward-search').fill('');
      await dialog.getByTestId(`forward-to-${ids[2]!}`).click();
      await expect(dialog.getByTestId(`forward-to-${ids[2]!}`)).toHaveAttribute(
        'data-selected',
        'true',
      );
      await dialog.getByTestId('forward-note').fill('for your files');
      await dialog.getByTestId('forward-send').click();
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });

      // Carol (a person Alice had no chat with yet) has it, forwarded, and the note after it.
      await firstChat(carol).click({ timeout: 20_000 });
      await expect(
        carol.window.getByTestId('message').filter({ hasText: 'the budget is approved' }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        carol.window.getByTestId('message-list').getByText('for your files'),
      ).toBeVisible();
    } finally {
      await close();
    }
  });
});

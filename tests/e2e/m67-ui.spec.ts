import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { wavBytes, writeSamples } from './fixtures.ts';
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

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

async function pair() {
  const roots = [tempDataRoot(), tempDataRoot()];
  const port = randomPort();
  const apps = await Promise.all(
    ['alice', 'bob'].map((n, i) => launchApp(n, roots[i]!.path, lanArgs(port))),
  );
  const ids = await Promise.all(apps.map(userIdOf));
  for (const [i, app] of apps.entries())
    await expectPerson(app.window, ids[1 - i]!).toHaveAttribute('data-online', 'true', {
      timeout: 20_000,
    });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { alice: apps[0]!, bob: apps[1]!, aliceId: ids[0]!, bobId: ids[1]!, roots, close };
}

const composerSend = async (page: Page) => {
  await page.getByTestId('composer').click();
  await page.getByTestId('composer').press('Enter');
};

/** The opacity of a message's reaction bar (it is hidden until the bubble is hovered). */
const barOpacity = (bubble: Locator) =>
  bubble.getByRole('toolbar').evaluate((el) => Number(getComputedStyle(el).opacity));

test.describe('M6.7', () => {
  test('the chat column is 910 px; who and when sit over the bubble; a day line; reactions only on the bubble', async () => {
    test.setTimeout(120_000);
    const { alice, bob, aliceId, bobId, close } = await pair();
    const a = alice.window;
    const b = bob.window;
    try {
      await alice.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.setSize(1700, 950);
      });
      await clickPerson(a, bobId);
      await a.getByTestId('composer').fill('Hello from Alice');
      await composerSend(a);
      await b.getByTestId(`conv-${aliceId}`).click();
      await expect(b.getByTestId('message').filter({ hasText: 'Hello from Alice' })).toBeVisible({
        timeout: 20_000,
      });
      await b.getByTestId('composer').fill('Hi Alice');
      await composerSend(b);
      const reply = a.getByTestId('message').filter({ hasText: 'Hi Alice' });
      await expect(reply).toBeVisible({ timeout: 20_000 });

      // The column: 910 px of bubbles and composer however wide the window (the pictures hang
      // outside it, in the free space either side).
      const contentWidth = (el: Locator) =>
        el.evaluate((node) => {
          const style = getComputedStyle(node);
          return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        });
      expect(
        Math.round(await contentWidth(a.getByTestId('message-list').locator('> div').first())),
      ).toBe(910);
      expect(Math.round(await contentWidth(a.getByTestId('typing-indicator').locator('..')))).toBe(
        910,
      );
      // The picture is outside the bubbles' column, the bubble starts where the composer does.
      const avatar = (await a.getByTestId('message-avatar').boundingBox())!;
      const bubble = (await reply.boundingBox())!;
      const composer = (await a.getByTestId('typing-indicator').boundingBox())!;
      expect(avatar.x + avatar.width).toBeLessThanOrEqual(bubble.x);
      expect(Math.abs(bubble.x - composer.x)).toBeLessThan(2);

      // A line for the day, and the time over each message, outside its bubble.
      await expect(a.getByTestId('day-separator').first()).toHaveText('Today');
      await expect(a.getByTestId('message').getByTestId('message-head')).toHaveCount(0);
      const heads = a.getByTestId('message-head');
      await expect(heads).toHaveCount(2);
      await expect(heads.first().getByTestId('message-time')).toHaveText(/\d{1,2}:\d{2}/);
      await a.screenshot({ path: `${SHOTS}/e2e-chat-look.png` });

      // The reaction bar: not over the empty part of the row, only over the bubble.
      await a.mouse.move(5, 5);
      await expect.poll(() => barOpacity(reply)).toBe(0);
      const box = (await reply.boundingBox())!;
      await a.mouse.move(box.x + 700, box.y + box.height / 2);
      await expect.poll(() => barOpacity(reply)).toBe(0);
      await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await expect.poll(() => barOpacity(reply)).toBe(1);
      await a.screenshot({ path: `${SHOTS}/e2e-hover-reactions.png` });
      // It still works: a reaction is added from the bar.
      await reply.getByTestId('react-\u{1F44D}').click();
      await expect(a.getByTestId('reaction-\u{1F44D}')).toBeVisible();
    } finally {
      await close();
    }
  });

  test('a PDF shows its first page in the bubble and opens in the built-in viewer', async () => {
    test.setTimeout(150_000);
    const { alice, bob, aliceId, bobId, roots, close } = await pair();
    const a = alice.window;
    const b = bob.window;
    try {
      const samples = writeSamples(roots[0]!.path);
      await clickPerson(a, bobId);
      await a.getByTestId('file-input').setInputFiles(samples['report.pdf']!);
      await composerSend(a);
      await b.getByTestId(`conv-${aliceId}`).click();

      const card = b.locator('[data-testid=file-card-preview][data-kind=pdf]');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.getByTestId('file-name')).toHaveText('report.pdf');
      // The first page is drawn in the bubble.
      await expect(card.getByTestId('file-preview')).toHaveAttribute('data-ready', 'true', {
        timeout: 30_000,
      });
      await expect(card).toContainText('2 pages');
      const picture = card.getByTestId('file-preview').locator('img');
      expect(await picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(
        100,
      );
      await b.screenshot({ path: `${SHOTS}/e2e-pdf-bubble.png` });

      // The viewer.
      await card.getByTestId('file-preview').click();
      const viewer = b.getByTestId('file-viewer');
      await expect(viewer).toBeVisible();
      await expect(viewer.getByTestId('viewer-title')).toHaveText('report.pdf');
      await expect(viewer.getByTestId('viewer-page-count')).toHaveText('of 2', { timeout: 30_000 });
      await expect(viewer.getByTestId('pdf-page')).toHaveCount(2);
      const first = viewer.locator('[data-page="1"]');
      await expect
        .poll(
          () =>
            first.locator('canvas').evaluate((c: HTMLCanvasElement) => {
              const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
              for (let i = 0; i < data.length; i += 4) if (data[i]! < 100) return true;
              return false;
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect(first.locator('.pdf-text-layer')).toContainText('Quarterly report', {
        timeout: 20_000,
      });
      await b.screenshot({ path: `${SHOTS}/e2e-pdf-viewer.png` });

      // Zoom, and fit.
      const widthOf = async () => (await first.boundingBox())!.width;
      const fitted = await widthOf();
      await viewer.getByTestId('viewer-zoom-in').click();
      await expect.poll(widthOf).toBeGreaterThan(fitted + 20);
      await viewer.getByTestId('viewer-fit').click();
      await expect.poll(widthOf).toBeCloseTo(fitted, -1);

      // Pages: next, previous, typing a number.
      await viewer.getByTestId('viewer-next').click();
      await expect(viewer.getByTestId('viewer-page-input')).toHaveValue('2');
      await viewer.getByTestId('viewer-prev').click();
      await expect(viewer.getByTestId('viewer-page-input')).toHaveValue('1');
      await viewer.getByTestId('viewer-page-input').fill('2');
      await viewer.getByTestId('viewer-page-input').press('Enter');
      await expect(viewer.getByTestId('viewer-page-input')).toHaveValue('2');

      // Search finds the word on page 2 and goes there; the word is marked.
      await viewer.getByTestId('viewer-prev').click();
      await viewer.getByTestId('viewer-search').click();
      await viewer.getByTestId('viewer-find').fill('needle');
      await expect(viewer.getByTestId('viewer-find-count')).toHaveText('1 of 1', {
        timeout: 20_000,
      });
      await expect(viewer.getByTestId('viewer-page-input')).toHaveValue('2');
      await expect(viewer.locator('[data-page="2"] .pdf-hit')).not.toHaveCount(0, {
        timeout: 20_000,
      });
      await b.screenshot({ path: `${SHOTS}/e2e-pdf-search.png` });

      // Close with the button; open again and close with Escape.
      await viewer.getByTestId('viewer-close').click();
      await expect(viewer).toHaveCount(0);
      await card.getByTestId('file-more').click();
      await b.getByTestId('file-menu-preview').click();
      await expect(b.getByTestId('file-viewer')).toBeVisible();
      await b.keyboard.press('Escape');
      await expect(b.getByTestId('file-viewer')).toHaveCount(0);

      // Forward is on the card.
      await card.getByTestId('file-forward').click();
      await expect(b.getByTestId(`forward-to-${aliceId}`)).toBeVisible();
    } finally {
      await close();
    }
  });

  test('Word, Excel, PowerPoint, CSV and text files show in the bubble and in the viewer', async () => {
    test.setTimeout(180_000);
    const { alice, bob, aliceId, bobId, roots, close } = await pair();
    const a = alice.window;
    const b = bob.window;
    try {
      const samples = writeSamples(roots[0]!.path);
      await clickPerson(a, bobId);
      await a
        .getByTestId('file-input')
        .setInputFiles(
          ['notes.docx', 'budget.xlsx', 'roadmap.pptx', 'people.csv', 'minutes.txt'].map(
            (n) => samples[n]!,
          ),
        );
      await composerSend(a);
      await b.getByTestId(`conv-${aliceId}`).click();

      const card = (kind: string) =>
        b.locator(`[data-testid=file-card-preview][data-kind=${kind}]`);
      const viewer = b.getByTestId('file-viewer');
      const open = async (kind: string, bubbleText: string) => {
        await expect(card(kind)).toBeVisible({ timeout: 30_000 });
        // A preview is made when the card is on screen (as when a person scrolls to it).
        await card(kind).scrollIntoViewIfNeeded();
        await expect(card(kind).getByTestId('file-preview')).toHaveAttribute('data-ready', 'true', {
          timeout: 30_000,
        });
        await expect(card(kind).getByTestId('file-preview')).toContainText(bubbleText);
        await card(kind).getByTestId('file-preview').click();
        await expect(viewer).toBeVisible();
      };
      const close_ = async () => {
        await viewer.getByTestId('viewer-close').click();
        await expect(viewer).toHaveCount(0);
      };

      await open('docx', 'Meeting notes');
      await expect(viewer.locator('h1')).toHaveText('Meeting notes', { timeout: 20_000 });
      await expect(viewer.getByTestId('viewer-docx')).toContainText('was approved by everyone');
      await expect(viewer.locator('.doc-marker')).toHaveCount(2);
      await expect(viewer.locator('table td').last()).toHaveText('Friday');
      await b.screenshot({ path: `${SHOTS}/e2e-docx-viewer.png` });
      await close_();

      await open('xlsx', 'Alice');
      const sheet = viewer.getByTestId('viewer-sheet');
      await expect(sheet).toContainText('Alice', { timeout: 20_000 });
      await expect(sheet).toContainText('1234.5');
      await expect(sheet).toContainText(/2023/); // the date column is a date, not 45000
      await viewer.getByTestId('viewer-sheet-tabs').getByRole('tab', { name: 'Notes' }).click();
      await expect(sheet).toContainText('Second sheet text');
      await b.screenshot({ path: `${SHOTS}/e2e-xlsx-viewer.png` });
      await close_();

      await open('pptx', 'Roadmap');
      const deck = viewer.getByTestId('viewer-pptx');
      await expect(deck).toContainText('Ship the viewer', { timeout: 20_000 });
      await expect(deck).toContainText('Then the release');
      await close_();

      await open('csv', 'Alice');
      await expect(viewer.getByTestId('viewer-sheet')).toContainText('Bob, Jr.', {
        timeout: 20_000,
      });
      await expect(viewer.getByTestId('viewer-sheet')).toContainText('Khulna');
      await close_();

      await open('text', 'Minutes of the quarterly meeting');
      await expect(viewer.getByTestId('viewer-text')).toContainText('Second line of the minutes', {
        timeout: 20_000,
      });
      await close_();
      await b.screenshot({ path: `${SHOTS}/e2e-file-bubbles.png` });
    } finally {
      await close();
    }
  });
  test('a picture opens in the viewer with zoom, and a sound plays in its bubble', async () => {
    test.setTimeout(120_000);
    const { alice, bob, aliceId, bobId, roots, close } = await pair();
    const a = alice.window;
    const b = bob.window;
    try {
      const png = resolve(import.meta.dirname, '../../apps/desktop/build/icon.png');
      const wav = join(roots[0]!.path, 'beep.wav');
      writeFileSync(wav, wavBytes());
      await clickPerson(a, bobId);
      await a.getByTestId('file-input').setInputFiles([png, wav]);
      await composerSend(a);
      await b.getByTestId(`conv-${aliceId}`).click();

      // The picture shows inline and opens in the viewer (not in another program).
      const picture = b.getByTestId('inline-image');
      await expect(picture).toHaveAttribute('data-state', 'complete', { timeout: 30_000 });
      await picture.click();
      const viewer = b.getByTestId('file-viewer');
      await expect(viewer).toBeVisible();
      const image = viewer.getByTestId('viewer-image');
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      const widthOf = async () => (await image.boundingBox())!.width;
      const fitted = await widthOf();
      await viewer.getByRole('button', { name: 'Zoom in' }).click();
      await expect.poll(widthOf).toBeGreaterThan(fitted);
      await viewer.getByRole('button', { name: 'Fit to width' }).click();
      await expect.poll(widthOf).toBeCloseTo(fitted, -1);
      await b.keyboard.press('Escape');
      await expect(viewer).toHaveCount(0);

      // The sound has a player in its bubble, and the file can be read as audio.
      const audio = b.getByTestId('inline-audio');
      await expect(audio).toBeVisible({ timeout: 30_000 });
      const seconds = await audio.evaluate(
        (el: HTMLAudioElement) =>
          new Promise<number>((resolveDuration, reject) => {
            el.addEventListener('loadedmetadata', () => resolveDuration(el.duration));
            el.addEventListener('error', () => reject(new Error('the audio did not load')));
            el.load();
          }),
      );
      expect(seconds).toBeGreaterThan(0.9);
      expect(seconds).toBeLessThan(1.1);
    } finally {
      await close();
    }
  });
});

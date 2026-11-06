import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { writeSamples } from './fixtures.ts';
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

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

/** Alice has no Office (the default in tests); Bob has a stand-in that writes a one-page PDF. */
async function pair() {
  const roots = [tempDataRoot(), tempDataRoot()];
  const port = randomPort();
  const report = join(roots[1]!.path, 'office-report.txt');
  writeFileSync(report, '');
  const alice = await launchApp('alice', roots[0]!.path, lanArgs(port));
  const bob = await launchApp('bob', roots[1]!.path, [...lanArgs(port), `--fake-office=${report}`]);
  const apps = [alice, bob];
  const ids = await Promise.all(apps.map(userIdOf));
  for (const [i, app] of apps.entries())
    await expectPerson(app.window, ids[1 - i]!).toHaveAttribute('data-online', 'true', {
      timeout: 20_000,
    });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  const drawn = () =>
    readFileSync(report, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { app: string; extension: string });
  return { alice, bob, aliceId: ids[0]!, bobId: ids[1]!, roots, close, drawn };
}

const send = async (page: Page, files: string[]) => {
  await page.getByTestId('file-input').setInputFiles(files);
  await page.getByTestId('composer').click();
  await page.getByTestId('composer').press('Enter');
};

const open = async (page: Page, name: string) => {
  const card = page.locator('[data-testid=file-card-preview]').filter({ hasText: name });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId('file-preview').click();
  await expect(page.getByTestId('file-viewer')).toBeVisible();
};

const close = async (page: Page) => {
  await page.getByTestId('viewer-close').click();
  await expect(page.getByTestId('file-viewer')).toHaveCount(0);
};

test.describe('M6.30 Office files drawn by Office', () => {
  test('with Office: Word and PowerPoint open as Office draws them, a spreadsheet as a grid with a page view, and old formats open too; without it the built-in drawing is used', async () => {
    test.setTimeout(180_000);
    const { alice, bob, aliceId, bobId, roots, close: shutDown, drawn } = await pair();
    const a = alice.window;
    const b = bob.window;
    try {
      const samples = writeSamples(roots[0]!.path);
      const old = join(roots[0]!.path, 'minutes.doc');
      writeFileSync(old, 'not really a Word 97 file');
      await clickPerson(a, bobId);
      await send(a, [
        samples['notes.docx']!,
        samples['budget.xlsx']!,
        samples['roadmap.pptx']!,
        old,
      ]);
      await b.getByTestId(`conv-${aliceId}`).click();

      // Word: the PDF Office drew, not the built-in page.
      await open(b, 'notes.docx');
      const pdf = b.getByTestId('viewer-pdf');
      await expect(pdf).toContainText('Drawn by Office as word', { timeout: 30_000 });
      await expect(b.getByTestId('viewer-docx')).toHaveCount(0);
      // Back to the simple view and again to Office's.
      await b.getByTestId('viewer-mode').click();
      await expect(b.getByTestId('viewer-docx')).toBeVisible();
      await expect(b.getByTestId('viewer-docx')).toContainText('Meeting notes');
      await b.getByTestId('viewer-mode').click();
      await expect(b.getByTestId('viewer-pdf')).toContainText('Drawn by Office as word');
      await close(b);

      // PowerPoint.
      await open(b, 'roadmap.pptx');
      await expect(b.getByTestId('viewer-pdf')).toContainText('Drawn by Office as powerpoint', {
        timeout: 30_000,
      });
      await close(b);

      // Excel opens as a grid; Office's page view is a click away.
      await open(b, 'budget.xlsx');
      await expect(b.getByTestId('viewer-sheet')).toContainText('Alice');
      await b.getByTestId('viewer-mode').click();
      await expect(b.getByTestId('viewer-pdf')).toContainText('Drawn by Office as excel', {
        timeout: 30_000,
      });
      await close(b);

      // A format the built-in drawing cannot read, drawn by Word.
      await open(b, 'minutes.doc');
      await expect(b.getByTestId('viewer-pdf')).toContainText('Drawn by Office as word', {
        timeout: 30_000,
      });
      await expect(b.getByTestId('viewer-mode')).toHaveCount(0);
      await close(b);

      // Each file was drawn once; opening Word's again reads the PDF kept for it.
      await open(b, 'notes.docx');
      await expect(b.getByTestId('viewer-pdf')).toContainText('Drawn by Office as word');
      await close(b);
      expect(drawn().map((d) => d.extension)).toEqual(['docx', 'pptx', 'xlsx', 'doc']);

      // No Office on Alice's PC: the built-in page with a line saying so, no toggle to nothing.
      await open(a, 'notes.docx');
      await expect(a.getByTestId('viewer-docx')).toContainText('Meeting notes');
      await expect(a.getByTestId('viewer-office-note')).toContainText(/not installed/);
      await expect(a.getByTestId('viewer-mode')).toHaveCount(0);
      await close(a);
      // ...and an old format has nothing to fall back on: it says so and offers the default app.
      await open(a, 'minutes.doc');
      await expect(a.getByTestId('viewer-message')).toContainText(
        /only be shown on a PC with Office/,
      );
      await close(a);
    } finally {
      await shutDown();
    }
  });
});

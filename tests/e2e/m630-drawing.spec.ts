import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { styledDocxBytes, styledPptxBytes, styledXlsxBytes } from './office-fixtures.ts';
import { clickPerson, expectPerson, lanArgs, launchApp, randomPort, tempDataRoot } from './app.ts';

/** The computed style of an element, by CSS property name. */
const styleOf = (target: Locator, ...props: string[]) =>
  target.evaluate((el, names) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n)]));
  }, props);

const openFile = async (page: Page, name: string) => {
  const card = page.locator('[data-testid=file-card-preview]').filter({ hasText: name });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId('file-preview').click();
  await expect(page.getByTestId('file-viewer')).toBeVisible();
};

test.describe('M6.30 the built-in drawing of Word, Excel and PowerPoint files', () => {
  test('a workbook, a document and a deck are drawn with the looks their files give them', async () => {
    test.setTimeout(180_000);
    const roots = [tempDataRoot(), tempDataRoot()];
    const port = randomPort();
    const alice = await launchApp('alice', roots[0]!.path, lanArgs(port));
    const bob = await launchApp('bob', roots[1]!.path, lanArgs(port));
    const b = bob.window;
    try {
      const idOf = async (app: typeof alice) => {
        await expect(app.window.getByTestId('user-id')).toHaveText(/^[a-z2-7]{32}$/);
        return (await app.window.getByTestId('user-id').textContent())!;
      };
      const [aliceId, bobId] = [await idOf(alice), await idOf(bob)];
      await expectPerson(alice.window, bobId).toHaveAttribute('data-online', 'true', {
        timeout: 20_000,
      });
      await expectPerson(b, aliceId).toHaveAttribute('data-online', 'true', { timeout: 20_000 });
      const files = {
        'sales.xlsx': styledXlsxBytes(),
        'review.docx': styledDocxBytes(),
        'plan.pptx': styledPptxBytes(),
      };
      const paths = Object.entries(files).map(([name, bytes]) => {
        const path = join(roots[0]!.path, name);
        writeFileSync(path, bytes);
        return path;
      });
      await clickPerson(alice.window, bobId);
      await alice.window.getByTestId('file-input').setInputFiles(paths);
      await alice.window.getByTestId('composer').click();
      await alice.window.getByTestId('composer').press('Enter');
      await b.getByTestId(`conv-${aliceId}`).click();
      await bob.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(1400, 900),
      );
      const close = async () => {
        await b.getByTestId('viewer-close').click();
        await expect(b.getByTestId('file-viewer')).toHaveCount(0);
      };

      // ---- Excel: fill, bold white text, a border, widths, a merged cell, a held row, hidden column
      await openFile(b, 'sales.xlsx');
      const sheet = b.getByTestId('viewer-sheet');
      await expect(sheet).toContainText('Region', { timeout: 20_000 });
      const head = sheet.locator('td', { hasText: 'Region' });
      expect(
        await styleOf(head, 'background-color', 'font-weight', 'color', 'text-align', 'position'),
      ).toMatchObject({
        'background-color': 'rgb(31, 78, 121)',
        'font-weight': '700',
        color: 'rgb(255, 255, 255)',
        'text-align': 'center',
        position: 'sticky',
      });
      expect(await styleOf(head, 'border-bottom-color', 'border-bottom-width')).toEqual({
        'border-bottom-color': 'rgb(255, 192, 0)',
        'border-bottom-width': '2px',
      });
      await expect(sheet.locator('col').nth(1)).toHaveCSS('width', '215px'); // 30 characters
      await expect(sheet.locator('tbody tr').first()).toHaveCSS('height', '40px'); // 30 points
      // A hidden column is not drawn (not its cells, not its letter).
      await expect(sheet).not.toContainText('Secret');
      expect(await sheet.locator('thead th').allTextContents()).toEqual(['', 'A', 'B']);
      // A merged cell spans its columns; a number has its format; no grid lines were asked for.
      await expect(sheet.locator('td', { hasText: 'Quarter one' })).toHaveAttribute('colspan', '2');
      await expect(sheet).toContainText('1,234.50');
      expect(await styleOf(sheet.locator('td', { hasText: 'North' }), 'border-top-color')).toEqual({
        'border-top-color': 'rgba(0, 0, 0, 0)',
      });
      await close();

      // ---- Word: the heading style, a paragraph's own look, a table style, the page and its header
      await openFile(b, 'review.docx');
      const doc = b.getByTestId('viewer-docx');
      await expect(doc).toContainText('Annual review', { timeout: 20_000 });
      const heading = doc.locator('h1');
      expect(await styleOf(heading, 'font-size', 'color', 'font-weight', 'margin-top')).toEqual({
        'font-size': '26.6667px', // 20 pt
        color: 'rgb(31, 78, 121)',
        'font-weight': '700',
        'margin-top': '32px', // 480 twentieths of a point
      });
      const red = doc.locator('p', { hasText: 'Centred and red' });
      expect(await styleOf(red, 'text-align')).toEqual({ 'text-align': 'center' });
      expect(
        await styleOf(red.locator('span').first(), 'color', 'font-style', 'font-size'),
      ).toEqual({
        color: 'rgb(192, 0, 0)',
        'font-style': 'italic',
        'font-size': '18.6667px', // 14 pt
      });
      const shaded = doc.locator('td', { hasText: 'Shaded' });
      expect(
        await styleOf(shaded, 'background-color', 'border-top-color', 'border-top-width'),
      ).toEqual({
        'background-color': 'rgb(217, 226, 243)',
        'border-top-color': 'rgb(255, 0, 0)',
        'border-top-width': '2px', // sz 12: an eighth of a point each
      });
      await expect(doc.locator('.doc-page')).toHaveCSS('padding-left', '144px'); // 2160 twentieths
      await expect(doc.locator('.doc-header')).toContainText('Confidential header');
      await close();

      // ---- PowerPoint: the master's background and title style, the layout's position, shapes
      await openFile(b, 'plan.pptx');
      const slide = b.getByTestId('viewer-pptx').getByTestId('slide').first();
      await expect(slide).toContainText('Quarterly plan', { timeout: 20_000 });
      const surface = slide.locator('> div > div').first();
      await expect(surface).toHaveCSS('background-color', 'rgb(245, 245, 220)'); // the master's
      const title = slide.locator('span', { hasText: 'Quarterly plan' });
      const titleStyle = await styleOf(title, 'color', 'font-weight', 'font-family');
      expect(titleStyle.color).toBe('rgb(17, 34, 51)'); // tx1, through the colour map, to dk1
      expect(titleStyle['font-weight']).toBe('700');
      expect(titleStyle['font-family']).toContain('Georgia'); // +mj-lt: the theme's heading font
      const titleSize = parseFloat((await styleOf(title, 'font-size'))['font-size']!);
      const slideWidth = (await slide.boundingBox())!.width;
      expect(titleSize).toBeCloseTo((40 / 720) * slideWidth, 0); // 40 pt of a 720 pt wide slide
      // Where the master puts the title (5% from the left), and where the box is on the slide.
      expect(
        await title.evaluate((el) => {
          let node = el as HTMLElement | null;
          while (node && !node.style.left.endsWith('%')) node = node.parentElement;
          return node?.style.left;
        }),
      ).toBe('5%');
      const redBox = slide.locator('span', { hasText: 'Red box' });
      expect(await styleOf(redBox, 'color', 'font-weight')).toEqual({
        color: 'rgb(255, 255, 255)', // bg1 is white
        'font-weight': '700',
      });
      expect(
        await redBox.evaluate((el) => {
          let node = el as HTMLElement | null;
          while (node && !node.style.background) node = node.parentElement;
          return { background: node?.style.background, left: node?.style.left };
        }),
      ).toEqual({ background: 'rgb(192, 0, 0)', left: '10%' });
      const picture = slide.locator('img');
      await expect(picture).toHaveCount(1);
      expect(await picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
      // A table: its header row in the theme's first accent, in white.
      const owner = slide.locator('td', { hasText: 'Owner' });
      expect(await styleOf(owner, 'background-color', 'font-weight')).toMatchObject({
        'background-color': 'rgb(0, 170, 85)',
      });
      await expect(slide.locator('td', { hasText: 'Friday' })).toBeVisible();
      await close();
    } finally {
      await Promise.allSettled([alice.close(), bob.close()]);
      roots.forEach((r) => r.dispose());
    }
  });
});

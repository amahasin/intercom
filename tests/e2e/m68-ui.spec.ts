import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
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
  const state = { alice: apps[0]!, bob: apps[1]! };
  const close = async () => {
    await Promise.allSettled([state.alice.close(), state.bob.close()]);
    roots.forEach((r) => r.dispose());
  };
  return { state, aliceId: ids[0]!, bobId: ids[1]!, roots, port, close };
}

function sparse(path: string, bytes: number): void {
  const fd = openSync(path, 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

const send = async (page: Page) => page.getByTestId('composer').press('Enter');

test.describe('M6.8', () => {
  test('a file card has its buttons at the bottom, and a big file is in the chat at once', async () => {
    test.setTimeout(150_000);
    const { state, bobId, roots, close } = await pair();
    const a = state.alice.window;
    try {
      const big = join(roots[0]!.path, 'firmware.bin');
      sparse(big, 2 * 1024 * 1024 * 1024);
      await clickPerson(a, bobId);
      await a.getByTestId('file-input').setInputFiles([big]);
      const started = Date.now();
      await a.getByTestId('composer').click();
      await send(a);
      // Nothing is read first: the real file message is there within a moment.
      await expect(a.getByTestId('file-card')).toBeVisible({ timeout: 8_000 });
      expect(Date.now() - started).toBeLessThan(8_000);
      await expect(a.getByTestId('pending-send')).toHaveCount(0);

      // The name and size on top, Open and Show in folder under them (not on the right).
      const card = a.getByTestId('file-card');
      await expect(card.getByTestId('file-open')).toBeVisible();
      const [cardBox, nameBox, openBox, folderBox] = await Promise.all([
        card.boundingBox(),
        card.getByText('firmware.bin').boundingBox(),
        card.getByTestId('file-open').boundingBox(),
        card.getByTestId('file-show-in-folder').boundingBox(),
      ]);
      expect(openBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);
      expect(folderBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);
      // Side by side, on the left, inside the card.
      expect(Math.abs(openBox!.y - folderBox!.y)).toBeLessThan(4);
      expect(folderBox!.x).toBeGreaterThan(openBox!.x + openBox!.width - 1);
      expect(openBox!.x).toBeLessThan(cardBox!.x + cardBox!.width / 3);
      expect(folderBox!.x + folderBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
      await a.screenshot({ path: `${SHOTS}/e2e-file-card-bottom-buttons.png` });
    } finally {
      await close();
    }
  });

  test('the Shared tab keeps each column to itself when the window is narrow', async () => {
    test.setTimeout(120_000);
    const { state, bobId, roots, close } = await pair();
    const a = state.alice.window;
    try {
      const names = [
        'Site_survey_final_version_for_the_visit_report_v2.zip',
        'US-9305_PP1_HILTI_R23 (1).rvt',
      ];
      await clickPerson(a, bobId);
      for (const name of names) {
        const path = join(roots[0]!.path, name);
        writeFileSync(path, 'x'.repeat(2048));
        await a.getByTestId('file-input').setInputFiles([path]);
        await a.getByTestId('composer').click();
        await send(a);
        await expect(a.getByTestId('message').filter({ hasText: name })).toBeVisible({
          timeout: 15_000,
        });
      }
      await a.getByTestId('tab-shared').click();
      await expect(a.getByTestId('file-row')).toHaveCount(2);

      for (const width of [1100, 760, 560]) {
        await state.alice.app.evaluate(({ BrowserWindow }, w) => {
          BrowserWindow.getAllWindows()[0]!.setSize(w, 800);
        }, width);
        await a.waitForTimeout(400);
        const overlaps = await a.getByTestId('files-table').evaluate((table) => {
          const bad: string[] = [];
          for (const row of table.querySelectorAll('tr, [role="row"]')) {
            const cells = [...row.querySelectorAll('td, th, [role="cell"], [role="columnheader"]')];
            cells.forEach((cell, i) => {
              const box = cell.getBoundingClientRect();
              // Whatever is inside must stay inside its own cell.
              for (const child of cell.querySelectorAll('*')) {
                const r = child.getBoundingClientRect();
                if (r.width > 0 && r.right > box.right + 1)
                  bad.push(
                    `cell ${i}: ${child.textContent?.slice(0, 30)} ends ${r.right} > ${box.right}`,
                  );
              }
              const next = cells[i + 1]?.getBoundingClientRect();
              if (next && box.right > next.left + 1) bad.push(`cell ${i} runs into the next`);
            });
          }
          return bad;
        });
        expect(overlaps, `width ${width}`).toEqual([]);
        // The header too: the name and its badge never sit over the presence line.
        const badge = await a.getByTestId('header-new-device').boundingBox();
        const presence = await a.getByTestId('header-presence').boundingBox();
        expect(badge!.y + badge!.height, `header at ${width}`).toBeLessThanOrEqual(presence!.y + 1);
        if (width === 560) await a.screenshot({ path: `${SHOTS}/e2e-shared-narrow.png` });
      }
    } finally {
      await close();
    }
  });

  test('a file sent to a colleague who is offline waits, and arrives by itself when they are back', async () => {
    test.setTimeout(180_000);
    const { state, aliceId, bobId, roots, port, close } = await pair();
    const a = state.alice.window;
    try {
      // Bob closes his app; Alice sees him go.
      await state.bob.close();
      await expectPerson(a, bobId).toHaveAttribute('data-online', 'false', {
        timeout: 30_000,
      });
      const path = join(roots[0]!.path, 'site-plan.bin');
      sparse(path, 64 * 1024 * 1024);
      await clickPerson(a, bobId);
      await a.getByTestId('file-input').setInputFiles([path]);
      await a.getByTestId('composer').click();
      await send(a);
      // The card says who it is waiting for.
      await expect(a.getByTestId('file-card')).toBeVisible({ timeout: 10_000 });
      await expect(a.getByTestId('file-queued')).toContainText('Waiting for');
      // Said once, on the card: not again under the bubble.
      await expect(a.getByText(/Waiting for .* to come online/)).toHaveCount(1);
      await a.screenshot({ path: `${SHOTS}/e2e-file-waiting.png` });

      // Bob's PC is on again: the file comes with no click, and Alice's note goes away.
      state.bob = await launchApp('bob', roots[1]!.path, lanArgs(port));
      const received = join(roots[1]!.path, 'downloads', 'InterCom', 'site-plan.bin');
      await expect
        .poll(() => (existsSync(received) ? statSync(received).size : 0), {
          timeout: 90_000,
          intervals: [500],
        })
        .toBe(64 * 1024 * 1024);
      await expect(a.getByTestId('file-queued')).toHaveCount(0, { timeout: 30_000 });
      void aliceId;
    } finally {
      await close();
    }
  });
});

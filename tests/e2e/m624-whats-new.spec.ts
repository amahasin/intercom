import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { appDir, launchApp, lanArgs, randomPort, tempDataRoot } from './app.ts';

const SHOTS = 'test-results/screens';
const VERSION = (
  JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string }
).version;

/** What an older version leaves behind: this profile last saw the notes of `seen`. */
function pretendOlder(root: string, seen: string | undefined): void {
  const db = new DatabaseSync(join(root, 'alice', 'officemesh.db'));
  try {
    if (seen === undefined) db.exec("DELETE FROM settings WHERE key = 'app.whatsNewSeen'");
    else
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('app.whatsNewSeen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(seen));
  } finally {
    db.close();
  }
}

test.describe('M6.24 What’s new after an update', () => {
  test('is not shown to a new profile, is shown once after an update, and can be opened from About', async () => {
    test.setTimeout(180_000);
    const root = tempDataRoot();
    const port = randomPort();
    try {
      // A new profile has nothing to catch up on.
      let run = await launchApp('alice', root.path, lanArgs(port));
      await expect(run.window.getByTestId('core-status')).toHaveAttribute('data-state', 'ready', {
        timeout: 30_000,
      });
      await run.window.waitForTimeout(1_500);
      await expect(run.window.getByTestId('whats-new')).toHaveCount(0);
      await run.close();

      // The same profile after an update (the last version it saw is older): the notes, once.
      pretendOlder(root.path, '0.18.2');
      run = await launchApp('alice', root.path, lanArgs(port));
      const w = run.window;
      const dialog = w.getByTestId('whats-new');
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await expect(dialog).toContainText(`What’s new in InterCom ${VERSION}`);
      // Only what came after 0.18.2, up to this version.
      await expect(dialog.getByTestId('whats-new-release')).toHaveCount(1);
      await expect(dialog.getByTestId('whats-new-release')).toHaveAttribute(
        'data-version',
        VERSION,
      );
      await expect(dialog).toContainText('Updates install by themselves');
      await expect(dialog.getByTestId('whats-new-close')).toBeVisible();
      // Nothing is cut off, and the notes scroll inside it rather than past the window.
      const box = (await dialog.boundingBox())!;
      const view = { height: await w.evaluate(() => window.innerHeight) };
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(view.height);
      await w.waitForTimeout(700);
      await w.screenshot({ path: `${SHOTS}/e2e-whats-new.png` });
      await dialog.getByTestId('whats-new-close').click();
      await expect(dialog).toHaveCount(0);
      await run.close();

      // Seen: not shown again after a restart.
      run = await launchApp('alice', root.path, lanArgs(port));
      await expect(run.window.getByTestId('core-status')).toHaveAttribute('data-state', 'ready', {
        timeout: 30_000,
      });
      await run.window.waitForTimeout(1_500);
      await expect(run.window.getByTestId('whats-new')).toHaveCount(0);

      // And it can be brought back: Settings > About.
      await run.window.getByTestId('me-avatar').click();
      await run.window.getByTestId('open-settings').click();
      await run.window.getByTestId('settings-tab-about').click();
      await run.window.getByTestId('about-whats-new').click();
      const again = run.window.getByTestId('whats-new');
      await expect(again).toBeVisible();
      // From there it is the recent releases, with a heading for each.
      await expect(again.getByTestId('whats-new-release').first()).toHaveAttribute(
        'data-version',
        VERSION,
      );
      await again.getByTestId('whats-new-x').click();
      await expect(again).toHaveCount(0);
      await run.close();

      // A profile from before this existed (nothing noted) is shown the recent notes once.
      pretendOlder(root.path, undefined);
      run = await launchApp('alice', root.path, lanArgs(port));
      await expect(run.window.getByTestId('whats-new')).toBeVisible({ timeout: 30_000 });
      await expect(run.window.getByTestId('whats-new-release').first()).toHaveAttribute(
        'data-version',
        VERSION,
      );
      await run.window.getByTestId('whats-new-close').click();
      await run.close();
    } finally {
      root.dispose();
    }
  });
});

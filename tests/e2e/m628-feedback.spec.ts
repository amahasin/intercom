import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  lanArgs,
  launchApp,
  randomPort,
  tempDataRoot,
  expectPerson,
  type RunningApp,
} from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;

interface Item {
  id: string;
  label: string;
  enabled?: boolean;
  checked?: boolean;
  dot?: string;
  separator?: boolean;
  children?: Item[];
}
interface Hooks {
  __officemeshTest: {
    trayMenu(): { items: Item[]; tooltip: string };
    clickTrayItem(id: string): boolean;
  };
}

/** Two apps on a private loopback LAN, each knowing the other; `extra` gives each its own switches. */
async function office(extra: string[][] = []) {
  const roots = [tempDataRoot(), tempDataRoot()];
  const port = randomPort();
  const apps = await Promise.all(
    ['alice', 'bob'].map((n, i) =>
      launchApp(n, roots[i]!.path, [...lanArgs(port), ...(extra[i] ?? [])]),
    ),
  );
  const ids: string[] = [];
  for (const app of apps) {
    await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
    ids.push((await app.window.getByTestId('user-id').textContent())!);
  }
  for (const [i, app] of apps.entries())
    await expectPerson(app.window, ids[1 - i]!).toHaveAttribute('data-online', 'true', {
      timeout: 30_000,
    });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps: apps as [RunningApp, RunningApp], ids, close };
}

const tray = (app: RunningApp) =>
  app.app.evaluate(() => (globalThis as unknown as Hooks).__officemeshTest.trayMenu());
const click = (app: RunningApp, id: string) =>
  app.app.evaluate(
    (_e, item) => (globalThis as unknown as Hooks).__officemeshTest.clickTrayItem(item),
    id,
  );
const presence = (page: Page) => page.getByTestId('me-avatar');

test.describe('M6.28 feedback round', () => {
  test('the tray menu: who you are, the status you can pick from it, what is unread, Open and Quit', async () => {
    test.setTimeout(150_000);
    const { apps, ids, close } = await office();
    const [alice, bob] = apps;
    try {
      // Once the core has told the tray who this is.
      await expect
        .poll(async () => (await tray(alice)).items[0]?.label, { timeout: 20_000 })
        .not.toBe('InterCom');
      let menu = await tray(alice);
      const name = menu.items[0]!.label;
      expect(menu.items.filter((i) => !i.separator).map((i) => i.id)).toEqual([
        'header',
        'status',
        'open',
        'quit',
      ]);
      expect(menu.items.find((i) => i.id === 'status')).toMatchObject({
        label: 'Available',
        dot: 'available',
      });
      expect(menu.tooltip).toBe(`InterCom: ${name}, Available`);

      // Pick Busy from the tray: the window and colleagues follow, and the menu shows it.
      expect(await click(alice, 'presence:busy')).toBe(true);
      await expect(presence(alice.window)).toHaveAttribute('data-presence', 'busy', {
        timeout: 10_000,
      });
      await expect
        .poll(async () => (await tray(alice)).items.find((i) => i.id === 'status')?.label)
        .toBe('Busy');
      menu = await tray(alice);
      expect(
        menu.items
          .find((i) => i.id === 'status')!
          .children!.filter((c) => c.checked)
          .map((c) => c.id),
      ).toEqual(['presence:busy']);
      expect(menu.tooltip).toContain('Busy');
      await bob.window.getByTestId('rail-people').click();
      await expect(bob.window.getByTestId(`person-${ids[0]}`)).toHaveAttribute(
        'aria-label',
        /, Busy$/,
        { timeout: 20_000 },
      );

      // Do not disturb, then Reset status (back to available).
      await click(alice, 'presence:dnd');
      await expect(presence(alice.window)).toHaveAttribute('data-presence', 'dnd', {
        timeout: 10_000,
      });
      await click(alice, 'status-reset');
      await expect(presence(alice.window)).toHaveAttribute('data-presence', 'available', {
        timeout: 10_000,
      });

      // The other way round: a change made in the window shows in the tray.
      await alice.window.getByTestId('me-avatar').click();
      await alice.window.getByTestId('presence-brb').click();
      await expect
        .poll(async () => (await tray(alice)).items.find((i) => i.id === 'status')?.label, {
          timeout: 10_000,
        })
        .toBe('Be right back');
      await click(alice, 'presence:available');

      // What is unread is listed, and goes when it is read.
      await bob.window.getByTestId('rail-people').click();
      await bob.window.getByTestId(`person-${ids[0]}`).click();
      await bob.window.getByTestId('person-chat').click();
      await bob.window.getByTestId('composer').click();
      await bob.window.keyboard.type('Are you there?');
      await bob.window.getByTestId('composer').press('Enter');
      await expect
        .poll(async () => (await tray(alice)).items.find((i) => i.id === 'unread')?.label, {
          timeout: 20_000,
        })
        .toBe('1 unread message');
      expect((await tray(alice)).tooltip).toContain('1 unread');

      // Open and Quit: quitting closes the app.
      expect(await click(alice, 'nonsense')).toBe(false);
      const closed = alice.app.waitForEvent('close', { timeout: 30_000 });
      await click(alice, 'quit');
      await closed;
    } finally {
      await close();
    }
  });

  test('Wake on LAN: for a colleague who is off, with an address typed in, kept, used and forgotten', async () => {
    test.setTimeout(150_000);
    const dir = mkdtempSync(join(tmpdir(), 'intercom-e2e-wake-'));
    const report = join(dir, 'wake.log');
    const lines = () =>
      existsSync(report)
        ? readFileSync(report, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { mac: string; bytes: number; to: string; port: number })
        : [];
    const { apps, ids, close } = await office([[`--fake-wake=${report}`]]);
    const [alice, bob] = apps;
    const a = alice.window;
    try {
      await a.getByTestId('rail-people').click();
      await a.getByTestId(`person-${ids[1]}`).click();
      // While they are on there is nothing to wake.
      await expect(a.getByTestId('wake-button')).toBeDisabled();

      // Bob's PC goes off.
      await bob.close();
      await expectPerson(a, ids[1]!).toHaveAttribute('data-online', 'false', { timeout: 60_000 });
      await expect(a.getByTestId('wake-button')).toBeEnabled({ timeout: 20_000 });

      // An address typed by hand, from the menu.
      await a.getByTestId('person-more-menu').click();
      await a.getByTestId('person-wake-address').click();
      await expect(a.getByTestId('wake-dialog')).toBeVisible();
      await a.getByTestId('wake-mac').fill('not an address');
      await a.getByTestId('wake-send').click();
      await expect(a.getByTestId('wake-error')).toContainText('hardware address');
      expect(lines()).toHaveLength(0);

      await a.getByTestId('wake-mac').fill('02-aa-bb-cc-dd-ee');
      await a.screenshot({ path: 'test-results/screens/e2e-wake-dialog.png' });
      await a.getByTestId('wake-send').click();
      await expect(a.getByTestId('wake-dialog')).toHaveCount(0);
      await expect(a.getByTestId('wake-button')).toHaveAttribute('data-sent', 'true');
      await expect(a.getByTestId('wake-button')).toContainText('Wake-up sent');
      // Packets of the right shape, with that address, on this PC's networks (and, as it is a
      // different network card than the colleague reported, only theirs and this one).
      await expect.poll(() => lines().length, { timeout: 10_000 }).toBeGreaterThan(0);
      const typed = lines().filter((l) => l.mac === '02aabbccddee');
      expect(typed.length).toBeGreaterThan(0);
      expect(typed.every((l) => l.bytes === 102 && (l.port === 9 || l.port === 7))).toBe(true);
      expect(typed.some((l) => l.to === '255.255.255.255')).toBe(true);

      // Kept: the dialog has it again, and the button now sends without asking.
      await a.getByTestId('person-more-menu').click();
      await a.getByTestId('person-wake-address').click();
      await expect(a.getByTestId('wake-mac')).toHaveValue('02:AA:BB:CC:DD:EE');
      await a.getByTestId('wake-forget').click();
      await expect(a.getByTestId('wake-mac')).toHaveValue('');
      await a.keyboard.press('Escape');
    } finally {
      await close();
    }
  });
});

import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
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
const PICTURE = resolve(import.meta.dirname, '../../apps/desktop/build/icon.png');

/** Two apps on a private loopback LAN; `env` sets test switches for one of them. */
async function pair(
  args: string[] = ['--fake-media'],
  env: [Record<string, string>, Record<string, string>] = [{}, {}],
) {
  const roots = [tempDataRoot(), tempDataRoot()];
  const port = randomPort();
  const apps = await Promise.all(
    ['alice', 'bob'].map((n, i) =>
      launchApp(n, roots[i]!.path, [...lanArgs(port), ...args], env[i]),
    ),
  );
  const ids: string[] = [];
  for (const app of apps) {
    await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
    ids.push((await app.window.getByTestId('user-id').textContent())!);
  }
  for (const [i, app] of apps.entries())
    await expectPerson(app.window, ids[1 - i]).toHaveAttribute('data-online', 'true', {
      timeout: 20_000,
    });
  const close = async () => {
    await Promise.allSettled(apps.map((a) => a.close()));
    roots.forEach((r) => r.dispose());
  };
  return { apps: apps as [RunningApp, RunningApp], ids, close };
}

test.describe('M6.20 feedback round', () => {
  test('email, notes and a picture on the profile: shown on the page, the hover cards and enlarged', async () => {
    test.setTimeout(150_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      // Alice edits her profile. An address that is not one cannot be saved.
      await a.getByTestId('me-avatar').click();
      await a.getByTestId('edit-profile').click();
      await a.getByTestId('profile-email-input').fill('not an address');
      await expect(a.getByTestId('profile-save')).toBeDisabled();
      await a.getByTestId('profile-email-input').fill('alice@office.example');
      await a.getByTestId('profile-notes-input').fill('In Mon-Thu.\nAsk me about the printers.');
      await a.getByTestId('profile-save').click();
      await expect(a.getByTestId('profile-saved')).toBeVisible();
      await a.getByTestId('avatar-input').setInputFiles(PICTURE);
      await a.screenshot({ path: `${SHOTS}/e2e-profile-edit.png` });
      await a.getByTestId('settings-close').click();

      // Her own page (the welcome page) has them too.
      await expect(a.getByTestId('own-page')).toBeVisible();
      await expect(a.getByTestId('person-email')).toContainText('alice@office.example');
      await expect(a.getByTestId('person-notes')).toContainText('Ask me about the printers.');
      await expect(a.getByTestId('person-notes')).toContainText('In Mon-Thu.');

      // Bob sees them on her page, and the picture opens large.
      await b.getByTestId('rail-people').click();
      await b.getByTestId(`person-${ids[0]}`).click();
      await expect(b.getByTestId('person-email')).toContainText('alice@office.example', {
        timeout: 20_000,
      });
      await expect(b.getByTestId('person-email').locator('a')).toHaveAttribute(
        'href',
        'mailto:alice@office.example',
      );
      await expect(b.getByTestId('person-notes')).toContainText('Ask me about the printers.');
      await expect(b.getByTestId('enlarge-picture')).toBeVisible({ timeout: 20_000 });
      await b.getByTestId('enlarge-picture').click();
      const big = b.getByTestId('enlarged-picture-image');
      await expect(big).toBeVisible();
      await expect
        .poll(() => big.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
        .toBe(true);
      expect(
        await big.evaluate((el: HTMLImageElement) => el.getBoundingClientRect().width),
      ).toBeGreaterThan(250);
      await b.screenshot({ path: `${SHOTS}/e2e-picture-enlarged.png` });
      await b.getByTestId('enlarged-picture-close').click();
      await expect(b.getByTestId('enlarged-picture')).toHaveCount(0);

      // Hover a colleague's picture in the People list (their page is on screen: the card offers
      // the chat). Their name and the rest of the row open nothing.
      await b.getByTestId(`person-${ids[0]}`).locator('.fui-Avatar').first().hover();
      await expect(b.getByTestId('profile-hover')).toBeVisible({ timeout: 5_000 });
      await expect(b.getByTestId('card-email')).toContainText('alice@office.example');
      await expect(b.getByTestId('card-notes')).toContainText('In Mon-Thu.');
      await expect(b.getByTestId('card-chat')).toBeVisible();
      await expect(b.getByTestId('card-profile')).toHaveCount(0);
      await b.mouse.move(2, 2);
      await expect(b.getByTestId('profile-hover')).toHaveCount(0);

      // In the chat with her, her picture shows the card on hover; its button is Profile, not Chat.
      // Her name beside it shows nothing.
      await b.getByTestId('person-chat').click();
      await expect(b.getByTestId('conversation')).toBeVisible();
      await b.mouse.move(2, 2);
      await b.getByTestId('header-title').hover();
      await b.waitForTimeout(900);
      await expect(b.getByTestId('profile-hover')).toHaveCount(0);
      await b.getByTestId('open-profile-card').hover();
      await expect(b.getByTestId('profile-hover')).toBeVisible({ timeout: 5_000 });
      await expect(b.getByTestId('card-email')).toContainText('alice@office.example');
      await expect(b.getByTestId('card-chat')).toHaveCount(0);
      await b.screenshot({ path: `${SHOTS}/e2e-header-hover-card.png` });
      await b.getByTestId('card-profile').click();
      await expect(b.getByTestId('person-page')).toBeVisible();
      await expect(b.getByTestId('person-name')).toContainText(/\w/);

      // The chat list: a conversation's picture shows the same card when the pointer rests on it.
      await b.getByTestId('rail-chat').click();
      await b.mouse.move(2, 2);
      await b.getByTestId(`conv-${ids[0]}`).locator('.fui-Avatar').first().hover();
      await expect(b.getByTestId('profile-hover')).toBeVisible({ timeout: 5_000 });
      await expect(b.getByTestId('card-profile')).toBeVisible();
      await b.screenshot({ path: `${SHOTS}/e2e-list-hover-card.png` });
    } finally {
      await close();
    }
  });

  test('pressing Escape twice in a chat goes back to your own page; Escape that closes something does not count', async () => {
    test.setTimeout(90_000);
    const { apps, ids, close } = await pair();
    const [alice] = apps;
    const a = alice.window;
    try {
      await clickPerson(a, ids[1]);
      await expect(a.getByTestId('conversation')).toBeVisible();

      // One press does nothing.
      await a.getByTestId('composer').click();
      await a.keyboard.press('Escape');
      await expect(a.getByTestId('conversation')).toBeVisible();

      // Escape that closes a menu is that menu's, and does not start the count.
      await a.getByTestId('notify-menu').click();
      await expect(a.getByTestId('notify-muted')).toBeVisible();
      await a.keyboard.press('Escape');
      await expect(a.getByTestId('notify-muted')).toHaveCount(0);
      await a.keyboard.press('Escape');
      await expect(a.getByTestId('conversation')).toBeVisible();

      // Two presses together leave the chat for the page about you, with everything on it.
      await a.waitForTimeout(700);
      await a.keyboard.press('Escape');
      await a.keyboard.press('Escape');
      await expect(a.getByTestId('own-page')).toBeVisible();
      await expect(a.getByTestId('conversation')).toHaveCount(0);
      await expect(a.getByTestId('user-id')).toHaveText(USER_ID);
      await expect(a.getByTestId('safety-phrase').locator('> *')).toHaveCount(6);
      await expect(a.getByTestId('person-host')).toContainText(/\w/);
      await expect(a.getByTestId('person-ip')).toContainText(/\d+\.\d+\.\d+\.\d+/);
      await expect(a.getByTestId('person-version')).toContainText(/\d+\.\d+\.\d+/);
      await a.screenshot({ path: `${SHOTS}/e2e-own-page.png` });

      // Presses a long while apart do not add up.
      await clickPerson(a, ids[1]);
      await a.getByTestId('composer').click();
      await a.keyboard.press('Escape');
      await a.waitForTimeout(900);
      await a.keyboard.press('Escape');
      await expect(a.getByTestId('conversation')).toBeVisible();
    } finally {
      await close();
    }
  });

  test('Details of a message: when it was delivered and when it was seen', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      await clickPerson(a, ids[1]);
      await a.getByTestId('composer').click();
      await a.keyboard.type('Did the printer get fixed?');
      await a.getByTestId('composer').press('Enter');
      const mine = a.getByTestId('message').filter({ hasText: 'Did the printer get fixed?' });
      await expect(mine).toBeVisible();

      await mine.hover();
      await mine.getByTestId('action-more').click();
      await a.getByTestId('action-details').click();
      const dialog = a.getByTestId('message-details');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('details-sent')).toContainText(/\d/);
      // It reached Bob's PC, with the time; he has not looked at the chat.
      await expect(dialog.getByTestId('details-delivered')).not.toHaveText('Not yet', {
        timeout: 20_000,
      });
      await expect(dialog.getByTestId('details-delivered')).toContainText(/\d/);
      await expect(dialog.getByTestId('details-seen')).toHaveText('Not yet');
      await a.screenshot({ path: `${SHOTS}/e2e-message-details-delivered.png` });

      // Bob opens the chat: it is seen, and the open dialog follows.
      await clickPerson(b, ids[0]);
      await expect(b.getByTestId('message').filter({ hasText: 'printer' })).toBeVisible();
      await expect(dialog.getByTestId('details-seen')).not.toHaveText('Not yet', {
        timeout: 20_000,
      });
      await expect(dialog.getByTestId('details-seen')).toContainText(/\d/);
      await a.screenshot({ path: `${SHOTS}/e2e-message-details-seen.png` });
      await a.getByTestId('message-details-close').click();
      await expect(dialog).toHaveCount(0);

      // For a message from the other person only when it was sent is known.
      const theirs = b.getByTestId('message').filter({ hasText: 'printer' });
      await theirs.hover();
      await theirs.getByTestId('action-more').click();
      await b.getByTestId('action-details').click();
      await expect(b.getByTestId('message-details').getByTestId('details-sent')).toContainText(
        /\d/,
      );
      await expect(b.getByTestId('details-delivered')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('Remote Desktop: a PC that is being used remotely says so on its page, its card and its own page', async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair(
      ['--fake-media', '--fake-remote-assist'],
      [
        {
          INTERCOM_FAKE_RDP: JSON.stringify([
            { state: 'active', client: 'LAPTOP-9', address: '10.0.0.7' },
          ]),
        },
        {},
      ],
    );
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      // Alice's own page tells her, in the same words.
      await expect(a.getByTestId('person-remote-text')).toContainText('LAPTOP-9', {
        timeout: 40_000,
      });
      await expect(a.getByTestId('person-remote-text')).toHaveAttribute('data-in-use', 'true');

      // Bob sees it on her page, with where it comes from.
      await b.getByTestId('rail-people').click();
      await b.getByTestId(`person-${ids[0]}`).click();
      await expect(b.getByTestId('person-remote-badge')).toBeVisible({ timeout: 40_000 });
      await expect(b.getByTestId('person-remote-text')).toContainText('LAPTOP-9');
      await expect(b.getByTestId('person-remote-text')).toContainText('10.0.0.7');
      await b.screenshot({ path: `${SHOTS}/e2e-remote-desktop.png` });

      // And on the card that opens when the pointer rests on her.
      await b.mouse.move(2, 2);
      await b.getByTestId(`person-${ids[0]}`).locator('.fui-Avatar').first().hover();
      await expect(b.getByTestId('card-remote')).toBeVisible({ timeout: 5_000 });

      // Bob's PC has nobody connected: his page for himself says so.
      await b.getByTestId('rail-chat').click();
      await expect(b.getByTestId('person-remote-text')).toContainText('Nobody is connected');
    } finally {
      await close();
    }
  });

  test('remote help: "Call" in the window rings the colleague, and the banner has it too', async () => {
    test.setTimeout(120_000);
    // Bob views Alice's screen; his (stand-in) viewer window presses Call a moment after it opens.
    const { apps, ids, close } = await pair(
      ['--fake-media', '--fake-remote-assist'],
      [{}, { INTERCOM_FAKE_ASSIST_CALL: '1' }],
    );
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      await clickPerson(a, ids[1]);
      await a.getByTestId('assist-menu').click();
      await a.getByTestId('assist-help-me').click();
      await b.getByTestId('assist-accept').click();
      await expect(b.getByTestId('assist-banner')).toHaveAttribute('data-state', 'open', {
        timeout: 20_000,
      });
      // The Call in the viewer window rang Alice.
      const ring = await windowWithRole(alice.app, 'incoming');
      await expect(ring.getByTestId('call-accept-audio')).toBeVisible();
      const bCall = await windowWithRole(bob.app, 'call');
      await bCall.getByTestId('call-hangup').click();

      // The banners offer the same button while it goes on.
      await expect(a.getByTestId('assist-banner').getByTestId('assist-call')).toBeVisible();
      await expect(b.getByTestId('assist-banner').getByTestId('assist-call')).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-assist-call-banner.png` });
    } finally {
      await close();
    }
  });
});

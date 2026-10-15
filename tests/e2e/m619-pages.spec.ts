import { hostname } from 'node:os';
import { expect, test } from '@playwright/test';
import {
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

/** Two apps on a private loopback LAN with synthetic media (calls ring and can be hung up). */
async function pair() {
  const roots = [tempDataRoot(), tempDataRoot()];
  const port = randomPort();
  const apps = await Promise.all(
    ['alice', 'bob'].map((n, i) =>
      launchApp(n, roots[i]!.path, [...lanArgs(port), '--fake-media']),
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

test.describe("M6.19 a colleague's page and the Calls page", () => {
  test("People: a click opens the colleague's page with their PC, status and what you did together", async () => {
    test.setTimeout(120_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      await a.getByTestId('rail-people').click();
      // Nothing is selected: the page says what to do.
      await expect(a.getByTestId('empty-pane')).toHaveAttribute('data-rail', 'people');
      await a.getByTestId(`person-${ids[1]}`).click();
      const page = a.getByTestId('person-page');
      await expect(page).toBeVisible();
      await expect(a.getByTestId('person-presence')).toHaveText('Available');
      await expect(a.getByTestId('person-title')).toHaveText('No designation set');

      // Their PC and InterCom, as reported in the handshake. Both apps run on this PC.
      await expect(a.getByTestId('person-host')).toContainText(hostname().slice(0, 64), {
        timeout: 30_000,
      });
      await expect(a.getByTestId('person-ip')).toContainText(/\d+\.\d+\.\d+\.\d+/);
      await expect(a.getByTestId('person-os')).toContainText(/\w/);
      await expect(a.getByTestId('person-cpu')).toContainText(/\w/);
      await expect(a.getByTestId('person-memory')).toContainText(/GB|MB/);
      await expect(a.getByTestId('person-arch')).toContainText(/\w/);
      await expect(a.getByTestId('person-version')).toContainText(/\d+\.\d+\.\d+/);
      await expect(a.getByTestId('person-version')).toContainText('Same as yours');

      // Nothing together yet.
      await expect(a.getByTestId('person-nothing')).toBeVisible();
      await expect(a.getByTestId('person-stat-messages')).toContainText('0');

      // Chat: opens the conversation; a message sent there shows on the page afterwards.
      await a.getByTestId('person-chat').click();
      await expect(a.getByTestId('conversation')).toBeVisible();
      await a.getByTestId('composer').click();
      await a.keyboard.type('Morning! Can you check page 3?');
      await a.getByTestId('composer').press('Enter');
      await expect(a.getByTestId('message').filter({ hasText: 'page 3' })).toBeVisible();
      await a.getByTestId('rail-people').click();
      await expect(a.getByTestId('person-page')).toBeVisible();
      await expect(a.getByTestId('person-stat-messages')).toContainText('1', { timeout: 10_000 });
      await expect(a.getByTestId('person-recent')).toContainText('Morning! Can you check page 3?');

      // A call that is not answered counts, and shows in the list.
      await a.getByTestId('person-audio').click();
      const ring = await windowWithRole(bob.app, 'incoming');
      const aCall = await windowWithRole(alice.app, 'call');
      await expect(ring.getByTestId('call-accept-audio')).toBeVisible();
      await aCall.getByTestId('call-hangup').click();
      await expect(a.getByTestId('person-stat-calls')).toContainText('1', { timeout: 15_000 });
      await expect(a.getByTestId('person-activity-item').first()).toHaveAttribute(
        'data-kind',
        'call',
      );

      // The buttons: more menu (copy), remote help, identity.
      await a.getByTestId('person-more-menu').click();
      await expect(a.getByTestId('person-copy-ip')).toBeVisible();
      await expect(a.getByTestId('person-copy-host')).toBeVisible();
      await expect(a.getByTestId('person-copy-id')).toBeVisible();
      await a.keyboard.press('Escape');
      await a.getByTestId('assist-menu').click();
      await expect(a.getByTestId('assist-help-me')).toBeVisible();
      await expect(a.getByTestId('assist-let-me-in')).toBeVisible();
      // The two choices are two rows each: the hint is under the choice, not beside it.
      const choice = await a.getByTestId('assist-help-me').boundingBox();
      const hint = await a
        .getByTestId('assist-help-me')
        .getByText('They see your screen and can control it')
        .boundingBox();
      expect(hint!.y).toBeGreaterThan(choice!.y + 10);
      await a.screenshot({ path: `${SHOTS}/e2e-assist-menu.png` });
      await a.keyboard.press('Escape');
      // (Both apps share a Windows name, so Bob's PC calls Alice a new device and shows the phrase.)
      const words = a.getByTestId('peer-safety-phrase');
      if (!(await words.isVisible())) await a.getByTestId('verify-toggle').click();
      await expect(words).toBeVisible();
      await a.screenshot({ path: `${SHOTS}/e2e-person-page.png`, fullPage: false });

      // Bob's own page for Alice: the same, from the other side (no activity he did not share).
      await b.getByTestId('rail-people').click();
      await b.getByTestId(`person-${ids[0]}`).click();
      await expect(b.getByTestId('person-stat-messages')).toContainText('1', { timeout: 10_000 });
    } finally {
      await close();
    }
  });

  test('Calls: dial by name, history with filters, details with a quick message', async () => {
    test.setTimeout(150_000);
    const { apps, ids, close } = await pair();
    const [alice, bob] = apps;
    const [a, b] = [alice.window, bob.window];
    try {
      // Alice rings Bob and hangs up before he answers: a missed call for Bob.
      await a.getByTestId('rail-calls').click();
      await expect(a.getByTestId('calls-view')).toBeVisible();
      await expect(a.getByTestId('calls-none')).toBeVisible();
      await expect(a.getByTestId('calls-select-hint')).toBeVisible();
      // The people list beside it offers who is online.
      await expect(a.getByTestId(`calls-person-${ids[1]}`)).toBeVisible();
      await a.getByTestId(`calls-call-${ids[1]}`).click({ force: true });
      const ring = await windowWithRole(bob.app, 'incoming');
      const aCall = await windowWithRole(alice.app, 'call');
      await expect(ring.getByTestId('call-accept-audio')).toBeVisible();
      await aCall.getByTestId('call-hangup').click();

      // Bob: the history has it, as missed; filters work.
      await b.getByTestId('rail-calls').click();
      const item = b.getByTestId('call-history-item');
      await expect(item).toHaveCount(1, { timeout: 15_000 });
      await expect(item).toHaveAttribute('data-outcome', 'missed');
      await expect(item).toContainText('Missed');
      await b.getByTestId('calls-filter-outgoing').click();
      await expect(item).toHaveCount(0);
      await expect(b.getByTestId('calls-none')).toBeVisible();
      await b.getByTestId('calls-filter-missed').click();
      await expect(item).toHaveCount(1);
      await b.getByTestId('calls-filter-all').click();

      // A click shows the details: who, actions, the quick message and the calls with them.
      await item.click();
      await expect(b.getByTestId('calls-person')).toBeVisible();
      await expect(b.getByTestId('calls-person-call')).toHaveCount(1);
      await expect(b.getByTestId('calls-action-chat')).toBeVisible();
      await expect(b.getByTestId('calls-action-audio')).toBeEnabled();
      await expect(b.getByTestId('calls-action-video')).toBeEnabled();
      await b.screenshot({ path: `${SHOTS}/e2e-calls-page.png` });

      // The quick message goes to Alice's chat.
      await b.getByTestId('calls-quick-input').fill('Sorry, missed you. Calling back.');
      await b.getByTestId('calls-quick-input').press('Enter');
      await expect(b.getByTestId('calls-quick-sent')).toBeVisible();
      await a.getByTestId('rail-chat').click();
      await a.getByTestId(`conv-${ids[1]}`).click();
      await expect(
        a.getByTestId('message').filter({ hasText: 'Sorry, missed you. Calling back.' }),
      ).toBeVisible({ timeout: 15_000 });

      // The profile button goes to the colleague's page.
      await b.getByTestId('calls-action-profile').click();
      await expect(b.getByTestId('person-page')).toBeVisible();

      // The dial box: type a name, call. Alice's window rings; Bob hangs up.
      await b.getByTestId('rail-calls').click();
      await b.getByTestId('calls-find').fill('zzzz-nobody');
      await expect(b.getByTestId('calls-dial-audio')).toBeDisabled();
      await b.getByTestId('calls-find').fill('');
      await b.getByTestId('calls-find').fill('a');
      await expect(b.getByTestId('calls-dial-audio')).toBeEnabled();
      await b.getByTestId('calls-dial-audio').click();
      const ring2 = await windowWithRole(alice.app, 'incoming');
      const bCall = await windowWithRole(bob.app, 'call');
      await expect(ring2.getByTestId('call-accept-audio')).toBeVisible();
      await bCall.getByTestId('call-hangup').click();
      await expect(b.getByTestId('call-history-item')).toHaveCount(2, { timeout: 15_000 });
      await b.screenshot({ path: `${SHOTS}/e2e-calls-page-2.png` });
    } finally {
      await close();
    }
  });
});

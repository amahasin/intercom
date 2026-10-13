import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
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

test.describe('M1 discovery, presence and 1:1 chat', () => {
  test('two instances find each other, chat, and show presence and delivery', async () => {
    const root = tempDataRoot();
    const port = randomPort();
    const [alice, bob] = await Promise.all([
      launchApp('alice', root.path, lanArgs(port)),
      launchApp('bob', root.path, lanArgs(port)),
    ]);
    try {
      const [aliceId, bobId] = await Promise.all([userIdOf(alice), userIdOf(bob)]);
      const a = alice.window;
      const b = bob.window;

      // Discovery within 10 s, no configuration.
      await expectPerson(a, bobId).toHaveAttribute('data-online', 'true', { timeout: 10_000 });
      await expectPerson(b, aliceId).toHaveAttribute('data-online', 'true', {
        timeout: 10_000,
      });

      // Both instances run under the same Windows account, so they share a display name:
      // the newcomer is flagged exactly as plan section 5 requires, and can be accepted.
      await clickPerson(a, bobId);
      await expect(a.getByTestId('conversation')).toBeVisible();
      await expect(a.getByTestId('header-new-device')).toBeVisible();
      await a.getByTestId('open-profile-card').click();
      await expect(a.getByTestId('profile-card')).toBeVisible();
      await a.keyboard.press('Escape');
      await expect(a.getByTestId('profile-card')).toHaveCount(0);
      await a.getByTestId('open-profile-card').click();
      await expect(a.getByTestId('new-device-warning')).toBeVisible();
      await expect(a.getByTestId('peer-safety-phrase').locator('> *')).toHaveCount(6);
      await a.getByTestId('accept-person').click();
      await expect(a.getByTestId('header-new-device')).toHaveCount(0);
      await expect(a.getByTestId('profile-card')).toHaveCount(0); // accepting closes the card
      await expect(a.getByTestId('open-profile-card')).toBeFocused();

      // Send a message: it shows on Bob's side and turns Delivered on Alice's.
      await a.getByTestId('composer').click();
      await a.keyboard.type('Hello from Alice');
      const sentAt = Date.now();
      await a.getByTestId('composer').press('Enter');
      await b.getByTestId(`conv-${aliceId}`).click();
      await expect(b.getByTestId('message').filter({ hasText: 'Hello from Alice' })).toBeVisible();
      const elapsed = Date.now() - sentAt;
      await expect(a.getByTestId('delivery-status')).toHaveAttribute(
        'data-status',
        /^(delivered|read)$/,
      );
      console.info(`UI round trip (type, send, open on the other side, render): ${elapsed} ms`);

      // Reply.
      await b.getByTestId('composer').click();
      await b.keyboard.type('Hi Alice!');
      await b.getByTestId('send').click();
      await expect(a.getByTestId('message').filter({ hasText: 'Hi Alice!' })).toBeVisible();

      // Presence: Bob goes Busy, Alice sees it.
      await b.getByTestId('me-avatar').click();
      await b.getByTestId('presence-busy').click();
      await expect(a.getByTestId('header-presence')).toContainText('Busy');

      await a.screenshot({ path: 'test-results/screens/m1-chat-alice.png' });

      // Bob quits: Alice sees Offline within 2 seconds.
      const quitAt = Date.now();
      await bob.close();
      await expectPerson(a, bobId).toHaveAttribute('data-online', 'false', { timeout: 2_000 });
      console.info(`offline after quit: ${Date.now() - quitAt} ms`);
      await expect(a.getByTestId('typing-indicator')).toContainText('is offline');
    } finally {
      await Promise.allSettled([alice.close(), bob.close()]);
      root.dispose();
    }
  });

  test('a message sent while the colleague is off arrives when they return, exactly once', async () => {
    const root = tempDataRoot();
    const port = randomPort();
    let alice = await launchApp('alice', root.path, lanArgs(port));
    let bob = await launchApp('bob', root.path, lanArgs(port));
    try {
      const aliceId = await userIdOf(alice);
      const bobId = await userIdOf(bob);
      await expectPerson(alice.window, bobId).toHaveAttribute('data-online', 'true', {
        timeout: 10_000,
      });
      await bob.close();
      await expectPerson(alice.window, bobId).toHaveAttribute('data-online', 'false', {
        timeout: 2_000,
      });

      await clickPerson(alice.window, bobId);
      await alice.window.getByTestId('composer').click();
      await alice.window.keyboard.type('Sent while you were away');
      await alice.window.getByTestId('composer').press('Enter');
      await expect(alice.window.getByTestId('delivery-status')).toHaveAttribute(
        'data-status',
        'waiting',
      );
      await expect(alice.window.getByTestId('delivery-status')).toContainText('Waiting for');

      // Alice restarts too: the outbox survives.
      await alice.close();
      alice = await launchApp('alice', root.path, lanArgs(port));
      bob = await launchApp('bob', root.path, lanArgs(port));
      await expect(bob.window.getByTestId(`conv-${aliceId}`)).toBeVisible({ timeout: 15_000 });
      await bob.window.getByTestId(`conv-${aliceId}`).click();
      await expect(bob.window.getByTestId('message')).toHaveCount(1);
      await expect(bob.window.getByTestId('message')).toContainText('Sent while you were away');

      await alice.window.getByTestId(`conv-${bobId}`).click();
      await expect(alice.window.getByTestId('delivery-status')).toHaveAttribute(
        'data-status',
        /^(delivered|read)$/,
        {
          timeout: 10_000,
        },
      );

      // Bob restarts once more: still exactly one copy.
      await bob.close();
      bob = await launchApp('bob', root.path, lanArgs(port));
      await expectPerson(bob.window, aliceId).toHaveAttribute('data-online', 'true', {
        timeout: 10_000,
      });
      await bob.window.getByTestId(`conv-${aliceId}`).click();
      await bob.window.waitForTimeout(1_500);
      await expect(bob.window.getByTestId('message')).toHaveCount(1);
    } finally {
      await Promise.allSettled([alice.close(), bob.close()]);
      root.dispose();
    }
  });

  test('asks to fix the firewall when rules are missing, and never asks for a Public network to be changed', async () => {
    const root = tempDataRoot();
    const missing = await launchApp('fw', root.path, lanArgs(randomPort(), 'missing'));
    try {
      await expect(missing.window.getByTestId('firewall-banner')).toBeVisible({ timeout: 10_000 });
      await expect(missing.window.getByTestId('firewall-fix')).toBeEnabled();
    } finally {
      await missing.close();
    }
    // On a Public network with the rules in place there is nothing to fix and nothing to say.
    const publicNet = await launchApp('pub', root.path, lanArgs(randomPort(), 'public'));
    try {
      await expect(publicNet.window.getByTestId('user-id')).toBeVisible({ timeout: 10_000 });
      await publicNet.window.waitForTimeout(1_500);
      await expect(publicNet.window.getByTestId('public-network-banner')).toHaveCount(0);
      await expect(publicNet.window.getByTestId('firewall-banner')).toHaveCount(0);
    } finally {
      await publicNet.close();
      root.dispose();
    }
  });

  test('200 colleagues: the people list stays responsive and the core stays under 2% CPU', async () => {
    test.setTimeout(150_000);
    const root = tempDataRoot();
    const port = randomPort();
    const app = await launchApp('alice', root.path, lanArgs(port));
    const sim: ChildProcess = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, '../../tools/sim/src/cli.ts'),
        '--peers=0',
        '--lite=200',
        '--lan=loopback',
        `--discovery-port=${port}`,
        '--exit-on-stdin-close',
      ],
      { stdio: ['pipe', 'ignore', 'inherit'] },
    );
    try {
      const w = app.window;
      await w.getByTestId('rail-people').click();
      await expect(w.getByTestId('chat-list')).toContainText('200 online', { timeout: 60_000 });
      // Let profile fetches finish and settle into steady state.
      await w.waitForTimeout(10_000);

      // Responsive: filtering 200 people updates within a frame or two.
      const filter = w.getByTestId('people-filter');
      const t0 = Date.now();
      await filter.fill('Esha');
      await expect(w.locator('[data-testid^="person-"]').first()).toContainText('Esha');
      const filterMs = Date.now() - t0;
      await filter.fill('');
      await w.getByTestId('chat-list').evaluate((el) => (el.scrollTop = el.scrollHeight));
      await w.screenshot({ path: 'test-results/screens/m1-200-people.png' });

      // Core CPU over 15 s of steady state, from the process's cumulative CPU seconds.
      const coreCpuSeconds = () =>
        app.app.evaluate(({ app: electronApp }) => {
          const m = electronApp
            .getAppMetrics()
            .find((x) => x.serviceName === 'InterCom Core' || x.name === 'InterCom Core');
          return m ? (m.cpu.cumulativeCPUUsage ?? -1) : -1;
        });
      const before = await coreCpuSeconds();
      const wallStart = Date.now();
      await w.waitForTimeout(15_000);
      const after = await coreCpuSeconds();
      const cpu = ((after - before) / ((Date.now() - wallStart) / 1000)) * 100;
      console.info(
        `200 colleagues: filter ${filterMs} ms; core process CPU ${cpu.toFixed(2)}% of one core (${(after - before).toFixed(3)} CPU-s in 15 s)`,
      );
      expect(before).toBeGreaterThanOrEqual(0);
      expect(cpu).toBeGreaterThanOrEqual(0);
      expect(cpu).toBeLessThan(2);
      expect(filterMs).toBeLessThan(1_000);
    } finally {
      sim.stdin?.end();
      await new Promise((r) => sim.once('exit', r));
      await app.close();
      root.dispose();
    }
  });
});

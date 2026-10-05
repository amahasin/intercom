import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { lanArgs, launchApp, randomPort, tempDataRoot, type RunningApp } from './app.ts';

const USER_ID = /^[a-z2-7]{32}$/;

interface RelayStats {
  epoch: number;
  connectedMs: number | null;
  audioPackets: number;
  videoFrames: number;
  consumers: number;
  remotes: string[];
}
const relayStats = (p: Page) =>
  p.evaluate(() =>
    (window as unknown as { officemeshRelay: () => Promise<RelayStats | null> }).officemeshRelay(),
  );

async function userIdOf(app: RunningApp): Promise<string> {
  await expect(app.window.getByTestId('user-id')).toHaveText(USER_ID);
  return (await app.window.getByTestId('user-id').textContent())!;
}

async function knowEachOther(apps: RunningApp[], ids: string[]) {
  for (const [i, app] of apps.entries())
    for (const [j, id] of ids.entries())
      if (i !== j)
        await expect(app.window.getByTestId(`person-${id}`)).toHaveAttribute(
          'data-online',
          'true',
          { timeout: 15_000 },
        );
}

test.describe('M6 scale-out', () => {
  test('a meeting outgrows the mesh, runs on the host relay, and survives the host being killed', async () => {
    test.setTimeout(180_000);
    const port = randomPort();
    const roots = [0, 1, 2].map(() => tempDataRoot());
    // Alice's and Bob's PCs can host (Alice better); Carol's cannot. Relay above 2 people.
    const scores = [2_000, 1_500, 0];
    const apps = await Promise.all(
      ['alice', 'bob', 'carol'].map((n, i) =>
        launchApp(n, roots[i]!.path, [
          ...lanArgs(port),
          '--fake-media',
          '--relay-above=2',
          `--relay-score=${scores[i]}`,
        ]),
      ),
    );
    const pages = apps.map((x) => x.window);
    const [a, b, c] = pages as [Page, Page, Page];
    try {
      const ids = await Promise.all(apps.map(userIdOf));
      await knowEachOther(apps, ids);
      await a.getByTestId('new-group').click();
      await a.getByTestId('group-title').fill('All hands');
      for (const id of ids.slice(1)) await a.getByTestId(`pick-${id}`).click();
      await a.getByTestId('group-create').click();
      for (const p of [b, c]) await p.getByTestId('chat-list').getByText('All hands').click();
      await a.getByTestId('meet-now').click();
      await expect(a.getByTestId('call-stage')).toBeVisible();
      for (const p of [b, c]) await p.getByTestId('call-card-join').click({ timeout: 15_000 });

      // Three people exceed the (test) mesh limit: everyone sends to and receives from
      // Alice's relay, video and audio.
      for (const p of pages) {
        await expect
          .poll(
            async () => {
              const s = await relayStats(p);
              return s !== null && s.videoFrames > 30 && s.audioPackets > 50;
            },
            { timeout: 30_000 },
          )
          .toBe(true);
      }
      await expect(c.getByTestId('call-tile')).toHaveCount(3);
      await expect(a.getByTestId('relay-host-stats')).toContainText('hosting this meeting for 3');
      expect((await relayStats(c))!.epoch).toBe(1);

      // Alice's PC dies (process tree killed): Bob takes over; Carol's media returns.
      const before = (await relayStats(c))!.videoFrames;
      const killedAt = Date.now();
      execFileSync('taskkill', ['/F', '/T', '/PID', String(apps[0]!.app.process().pid)]);
      for (const p of [b, c]) {
        await expect
          .poll(
            async () => {
              const s = await relayStats(p);
              return s !== null && s.epoch === 2 && s.videoFrames > 0;
            },
            { timeout: 15_000 },
          )
          .toBe(true);
      }
      await expect
        .poll(async () => (await relayStats(c))!.audioPackets, { timeout: 10_000 })
        .toBeGreaterThan(0);
      const recovered = Date.now() - killedAt;
      console.log(`relay host killed: media back after ${recovered} ms (frames before ${before})`);
      expect(recovered).toBeLessThan(10_000);
      await expect(c.getByTestId('call-tile')).toHaveCount(2, { timeout: 15_000 });
      await expect(b.getByTestId('relay-host-stats')).toBeVisible({ timeout: 10_000 });
    } finally {
      await Promise.allSettled(apps.slice(1).map((x) => x.close()));
      roots.forEach((r) => r.dispose());
    }
  });

  test('a direct message reaches its recipient through a colleague while the sender is off', async () => {
    test.setTimeout(120_000);
    const port = randomPort();
    const roots = [0, 1, 2].map(() => tempDataRoot());
    let alice = await launchApp('alice', roots[0]!.path, lanArgs(port));
    let bob = await launchApp('bob', roots[1]!.path, lanArgs(port));
    const carol = await launchApp('carol', roots[2]!.path, lanArgs(port));
    try {
      const ids = await Promise.all([alice, bob, carol].map(userIdOf));
      await knowEachOther([alice, bob, carol], ids);
      const [aliceId, bobId] = ids as [string, string, string];
      await bob.close();
      await expect(alice.window.getByTestId(`person-${bobId}`)).toHaveAttribute(
        'data-online',
        'false',
        { timeout: 5_000 },
      );
      await alice.window.getByTestId(`person-${bobId}`).click();
      await alice.window.getByTestId('composer').click();
      await alice.window.keyboard.type('Left with a colleague for you');
      await alice.window.getByTestId('composer').press('Enter');
      await expect(alice.window.getByTestId('delivery-status')).toHaveAttribute(
        'data-status',
        'carried',
        { timeout: 10_000 },
      );
      await expect(alice.window.getByTestId('delivery-status')).toContainText(
        'Will be delivered when',
      );
      // The sender goes off before the recipient comes back.
      await alice.close();
      bob = await launchApp('bob', roots[1]!.path, lanArgs(port));
      await expect(bob.window.getByTestId(`conv-${aliceId}`)).toBeVisible({ timeout: 20_000 });
      await bob.window.getByTestId(`conv-${aliceId}`).click();
      await expect(bob.window.getByTestId('message')).toContainText(
        'Left with a colleague for you',
      );
      // When Alice returns she sees it delivered.
      alice = await launchApp('alice', roots[0]!.path, lanArgs(port));
      await alice.window.getByTestId(`conv-${bobId}`).click();
      await expect(alice.window.getByTestId('delivery-status')).toHaveAttribute(
        'data-status',
        /^(delivered|read)$/,
        { timeout: 20_000 },
      );
    } finally {
      await Promise.allSettled([alice.close(), bob.close(), carol.close()]);
      roots.forEach((r) => r.dispose());
    }
  });

  test('one typed address joins two subnets; diagnostics show the link', async () => {
    test.setTimeout(120_000);
    // Different discovery ports: their beacons never meet, as across a router.
    const roots = [0, 1, 2].map(() => tempDataRoot());
    const [p1, p2] = [randomPort(), randomPort()];
    const alice = await launchApp('alice', roots[0]!.path, lanArgs(p1));
    const bob = await launchApp('bob', roots[1]!.path, lanArgs(p2));
    const dan = await launchApp('dan', roots[2]!.path, lanArgs(p2));
    try {
      const [aliceId, bobId, danId] = (await Promise.all([alice, bob, dan].map(userIdOf))) as [
        string,
        string,
        string,
      ];
      await knowEachOther([bob, dan], [bobId, danId]);
      await expect(alice.window.getByTestId(`person-${bobId}`)).toHaveCount(0);
      // Bob reads his link port from Diagnostics.
      await bob.window.getByTestId('me-avatar').click();
      await bob.window.getByTestId('open-settings').click();
      await bob.window.getByTestId('diagnostics-show').click();
      const text = (await bob.window.getByTestId('diagnostics').textContent())!;
      const linkPort = /link port (\d+)/.exec(text)?.[1];
      expect(linkPort).toBeTruthy();
      // Alice adds him by address: Dan, on Bob's subnet, appears too.
      await alice.window.getByTestId('me-avatar').click();
      await alice.window.getByTestId('open-settings').click();
      await alice.window.getByTestId('peer-address').fill(`127.0.0.1:${linkPort}`);
      await alice.window.getByTestId('peer-add').click();
      await expect(alice.window.getByTestId('peer-add-note')).toContainText('Connected to', {
        timeout: 15_000,
      });
      // (Settings stays open; the people list behind it updates.)
      for (const id of [bobId, danId])
        await expect(alice.window.getByTestId(`person-${id}`)).toHaveAttribute(
          'data-online',
          'true',
          { timeout: 20_000 },
        );
      await expect(dan.window.getByTestId(`person-${aliceId}`)).toHaveAttribute(
        'data-online',
        'true',
        { timeout: 20_000 },
      );
      await alice.window.getByTestId('diagnostics-show').click();
      await expect(alice.window.getByTestId('diagnostics')).toContainText('2 on other subnets');
    } finally {
      await Promise.allSettled([alice.close(), bob.close(), dan.close()]);
      roots.forEach((r) => r.dispose());
    }
  });
});

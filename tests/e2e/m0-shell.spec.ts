import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { lanArgs, launchApp as launch, randomPort, runRaw, tempDataRoot } from './app.ts';

// Every instance stays on a private loopback LAN, never the real office network.
const launchApp = (profile: string, dataRoot: string) =>
  launch(profile, dataRoot, lanArgs(randomPort()));

const USER_ID = /^[a-z2-7]{32}$/;

test.describe('M0 shell', () => {
  test('opens a Fluent shell showing the generated name and userId', async () => {
    const root = tempDataRoot();
    const alice = await launchApp('alice', root.path);
    try {
      const w = alice.window;
      await expect(w.getByTestId('core-status')).toHaveAttribute('data-state', 'ready');
      await expect(w.getByTestId('display-name')).not.toBeEmpty();
      await expect(w.getByTestId('user-id')).toHaveText(USER_ID);
      await expect(w.getByTestId('safety-phrase').locator('> *')).toHaveCount(6);
      await expect(w.getByTestId('profile-name')).toHaveText('alice');
      await expect(w.getByTestId('key-protection')).toHaveText('Protected by your Windows account');
      for (const rail of ['activity', 'chat', 'teams', 'calendar', 'calls', 'files']) {
        await expect(w.getByTestId(`rail-${rail}`)).toBeVisible();
      }
      await w.getByTestId('rail-teams').click();
      await expect(w.getByRole('heading', { name: 'Teams' })).toBeVisible();
      await w.getByTestId('rail-chat').click();
      await w.screenshot({ path: 'test-results/screens/m0-shell.png' });
      await w.emulateMedia({ colorScheme: 'dark' });
      await expect(w.getByTestId('display-name')).toBeVisible();
      await w.screenshot({ path: 'test-results/screens/m0-shell-dark.png' });
    } finally {
      await alice.close();
      root.dispose();
    }
  });

  test('runs two profiles side by side with distinct identities', async () => {
    const root = tempDataRoot();
    const [alice, bob] = await Promise.all([
      launchApp('alice', root.path),
      launchApp('bob', root.path),
    ]);
    try {
      await expect(alice.window.getByTestId('user-id')).toHaveText(USER_ID);
      await expect(bob.window.getByTestId('user-id')).toHaveText(USER_ID);
      const a = await alice.window.getByTestId('user-id').textContent();
      const b = await bob.window.getByTestId('user-id').textContent();
      expect(a).not.toBe(b);
      await expect(bob.window.getByTestId('profile-name')).toHaveText('bob');
    } finally {
      await Promise.all([alice.close(), bob.close()]);
      root.dispose();
    }
  });

  test('keeps the same identity across restarts', async () => {
    const root = tempDataRoot();
    try {
      const first = await launchApp('alice', root.path);
      const id = await first.window.getByTestId('user-id').textContent();
      expect(id).toMatch(USER_ID);
      await first.close();
      const second = await launchApp('alice', root.path);
      await expect(second.window.getByTestId('user-id')).toHaveText(id!);
      await second.close();
    } finally {
      root.dispose();
    }
  });

  test('a second instance of the same profile exits and leaves the first running', async () => {
    const root = tempDataRoot();
    const alice = await launchApp('alice', root.path);
    try {
      await expect(alice.window.getByTestId('core-status')).toHaveAttribute('data-state', 'ready');
      const second = await runRaw([`--profile=alice`, `--data-root=${root.path}`], 20_000);
      expect(second.timedOut).toBe(false);
      await expect(alice.window.getByTestId('user-id')).toHaveText(USER_ID);
    } finally {
      await alice.close();
      root.dispose();
    }
  });

  test('a key that cannot be unsealed stops start-up instead of creating a new identity', async () => {
    const root = tempDataRoot();
    try {
      const first = await launchApp('alice', root.path);
      await expect(first.window.getByTestId('user-id')).toHaveText(USER_ID);
      await first.close();

      // Corrupt the sealed bytes, as if the key came from another Windows account.
      const keyPath = join(root.path, 'alice', 'identity.key');
      const keyFile = JSON.parse(readFileSync(keyPath, 'utf8')) as { sealed: string };
      const sealed = Buffer.from(keyFile.sealed, 'base64url');
      sealed[sealed.length - 1]! ^= 0xff;
      const tampered = JSON.stringify({ ...keyFile, sealed: sealed.toString('base64url') });
      writeFileSync(keyPath, tampered);

      const second = await launchApp('alice', root.path);
      await expect(second.window.getByTestId('core-status')).toHaveAttribute('data-state', 'error');
      await expect(second.window.getByText('InterCom could not start')).toBeVisible();
      await expect(second.window.getByTestId('user-id')).toHaveCount(0);
      await second.close();
      expect(readFileSync(keyPath, 'utf8')).toBe(tampered);
    } finally {
      root.dispose();
    }
  });

  test('stores the private key sealed by safeStorage (DPAPI), never in plaintext', async () => {
    const root = tempDataRoot();
    const alice = await launchApp('alice', root.path);
    try {
      await expect(alice.window.getByTestId('core-status')).toHaveAttribute('data-state', 'ready');
      const keyFile = JSON.parse(
        readFileSync(join(root.path, 'alice', 'identity.key'), 'utf8'),
      ) as {
        scheme: string;
        sealed: string;
      };
      expect(keyFile.scheme).toBe('safeStorage');
      const sealed = Buffer.from(keyFile.sealed, 'base64url');
      // Chromium os_crypt framing ("v10" + AES-256-GCM); a PKCS#8 DER key would start 0x30 0x81/0x82.
      expect(sealed.subarray(0, 3).toString('latin1')).toMatch(/^v\d\d$/);
      expect(sealed.toString('latin1')).not.toMatch(/PRIVATE KEY/);
      // The AES key itself is wrapped by DPAPI for the current Windows user. Chromium
      // flushes Local State lazily, so read it after the app has exited.
      await alice.close();
      const localState = JSON.parse(
        readFileSync(join(root.path, 'alice', 'chromium', 'Local State'), 'utf8'),
      ) as {
        os_crypt?: { encrypted_key?: string };
      };
      const wrapped = Buffer.from(localState.os_crypt?.encrypted_key ?? '', 'base64');
      expect(wrapped.subarray(0, 5).toString('latin1')).toBe('DPAPI');
    } finally {
      await alice.close();
      root.dispose();
    }
  });
});

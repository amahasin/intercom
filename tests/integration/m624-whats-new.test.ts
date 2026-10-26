/**
 * M6.24: "What's new" after an update. The core keeps the version whose notes were seen: a profile
 * made by this version starts with it, one that has run before keeps what it had (so a newer app is
 * shown the notes once), and a profile from before the setting existed is shown the recent notes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Core, silentLogger } from '@officemesh/core';
import { InsecureTestKeyProtector } from '@officemesh/core/testing';
import {
  compareVersions,
  hasUnseen,
  notesSince,
  RELEASE_NOTES,
} from '../../apps/desktop/renderer/src/releaseNotes.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'officemesh-whatsnew-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

/** A core with no network, as the version `appVersion`, on the profile in `root`. */
async function start(root: string, appVersion: string): Promise<Core> {
  const core = await Core.start({
    dataDir: join(root, 'alice'),
    profile: 'alice',
    appVersion,
    keyProtector: new InsecureTestKeyProtector(),
    logger: silentLogger,
    defaultDisplayName: async () => 'Alice',
  });
  return core;
}

describe('M6.24 the core keeps which "What\'s new" was seen', () => {
  it('a profile made by this version starts with its notes as seen (nothing to catch up on)', async () => {
    const root = tempRoot();
    const core = await start(root, '0.18.2');
    expect(core.settings().whatsNewSeen).toBe('0.18.2');
    await core.close();
  });

  it('keeps it across restarts, and a newer app finds an older version noted (the notes are due)', async () => {
    const root = tempRoot();
    await (await start(root, '0.18.1')).close();
    // The same version again: still seen.
    const same = await start(root, '0.18.1');
    expect(same.settings().whatsNewSeen).toBe('0.18.1');
    await same.close();
    // The update: the app is newer than what was seen.
    const updated = await start(root, '0.18.2');
    expect(updated.settings().whatsNewSeen).toBe('0.18.1');
    expect(hasUnseen(updated.settings().whatsNewSeen, '0.18.2')).toBe(true);
    // Seen: noted, and kept after the next start.
    updated.setSettings({ whatsNewSeen: '0.18.2' });
    expect(updated.settings().whatsNewSeen).toBe('0.18.2');
    await updated.close();
    const again = await start(root, '0.18.2');
    expect(again.settings().whatsNewSeen).toBe('0.18.2');
    expect(hasUnseen(again.settings().whatsNewSeen, '0.18.2')).toBe(false);
    await again.close();
  });

  it('a profile from before the setting existed is not mistaken for a new one', async () => {
    const root = tempRoot();
    const first = await start(root, '0.18.1');
    // What an older version left: it had run, and had no such setting.
    first.store.db.prepare("DELETE FROM settings WHERE key = 'app.whatsNewSeen'").run();
    await first.close();
    const upgraded = await start(root, '0.18.2');
    expect(upgraded.settings().whatsNewSeen).toBe('');
    expect(hasUnseen('', '0.18.2')).toBe(true);
    await upgraded.close();
  });
});

describe('M6.24 which notes are shown', () => {
  it('compares versions as numbers, not as text', () => {
    expect(compareVersions('0.18.2', '0.18.10')).toBeLessThan(0);
    expect(compareVersions('0.9.0', '0.18.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.18.2', '0.18.2')).toBe(0);
    expect(compareVersions('0.18.2-beta', '0.18.2')).toBe(0);
    expect(compareVersions('', '0.0.1')).toBeLessThan(0);
  });

  it('shows what came after the version last seen, up to the one that runs, newest first', () => {
    expect(notesSince('0.18.1', '0.18.2').map((n) => n.version)).toEqual(['0.18.2']);
    // Not known (a profile from before): the recent ones.
    expect(notesSince('', '0.18.2').map((n) => n.version)).toEqual(['0.18.2', '0.18.1']);
    expect(notesSince('', '0.18.2', 1).map((n) => n.version)).toEqual(['0.18.2']);
    // Already seen, or running something older than the notes: nothing.
    expect(notesSince('0.18.2', '0.18.2')).toEqual([]);
    expect(notesSince('0.18.1', '0.18.1')).toEqual([]);
    // A release with no notes of its own is passed over, not announced with older ones.
    expect(notesSince('0.18.2', '0.18.3')).toEqual([]);
    // Notes written for a version this one is not yet are never shown.
    expect(notesSince('', '0.18.1').map((n) => n.version)).toEqual(['0.18.1']);
  });

  it('is due only when the version last seen is older than the one running', () => {
    expect(hasUnseen('0.18.1', '0.18.2')).toBe(true);
    expect(hasUnseen('0.18.2', '0.18.2')).toBe(false);
    expect(hasUnseen('0.18.3', '0.18.2')).toBe(false);
    // Before the version is known there is nothing to compare.
    expect(hasUnseen('', '')).toBe(false);
  });

  it('has notes that are well formed, newest first, and none for a version that does not exist yet', () => {
    const versions = RELEASE_NOTES.map((n) => n.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < versions.length; i++)
      expect(compareVersions(versions[i - 1]!, versions[i]!)).toBeGreaterThan(0);
    for (const note of RELEASE_NOTES) {
      const items = [...note.added, ...note.improved, ...note.fixed];
      expect(items.length, note.version).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.title.trim().length).toBeGreaterThan(0);
        // A sentence people can read at a glance, not a paragraph.
        expect(item.text.trim().length).toBeGreaterThan(20);
        expect(item.text.length).toBeLessThan(300);
      }
      const titles = items.map((i) => i.title);
      expect(new Set(titles).size, `titles in ${note.version}`).toBe(titles.length);
    }
    const app = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../apps/desktop/package.json'), 'utf8'),
    ) as {
      version: string;
    };
    expect(compareVersions(versions[0]!, app.version)).toBeLessThanOrEqual(0);
  });
});

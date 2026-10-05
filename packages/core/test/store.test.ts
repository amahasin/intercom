import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { MIGRATIONS, Store, type Migration } from '../src/index.ts';
import { makeTempDir } from '../src/testing/index.ts';

const dirs: Array<{ dispose: () => void }> = [];
afterEach(() => dirs.splice(0).forEach((d) => d.dispose()));

function tempDb(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return join(dir.path, 'test.db');
}

describe('store migrations', () => {
  it('applies every migration and records the version', () => {
    const store = Store.open(tempDb());
    expect(store.schemaVersion).toBe(MIGRATIONS.at(-1)!.version);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .pluck()
      .all();
    expect(tables).toEqual(expect.arrayContaining(['identity', 'settings']));
    store.close();
  });

  it('runs only new migrations when reopened', () => {
    const file = tempDb();
    Store.open(file).close();
    const extra: Migration = {
      version: MIGRATIONS.length + 1,
      name: 'extra',
      sql: 'CREATE TABLE extra (x INTEGER) STRICT;',
    };
    const store = Store.open(file, [...MIGRATIONS, extra]);
    expect(store.schemaVersion).toBe(extra.version);
    store.close();
    // Reopening again must not re-run (CREATE TABLE would fail if it did).
    Store.open(file, [...MIGRATIONS, extra]).close();
  });

  it('rolls back a failing migration as a unit', () => {
    const file = tempDb();
    const bad: Migration = {
      version: MIGRATIONS.length + 1,
      name: 'bad',
      sql: 'CREATE TABLE ok (x INTEGER); SELECT * FROM missing;',
    };
    expect(() => Store.open(file, [...MIGRATIONS, bad])).toThrow();
    const store = Store.open(file);
    expect(store.schemaVersion).toBe(MIGRATIONS.length);
    expect(
      store.db.prepare("SELECT count(*) FROM sqlite_master WHERE name='ok'").pluck().get(),
    ).toBe(0);
    store.close();
  });

  it('refuses a database from a newer app version', () => {
    const file = tempDb();
    const future: Migration = { version: 99, name: 'future', sql: 'SELECT 1;' };
    Store.open(file, [...MIGRATIONS, future]).close();
    expect(() => Store.open(file)).toThrow(/newer than this app/);
  });

  it('has FTS5 available for search', () => {
    const store = Store.open(tempDb());
    store.db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(body); INSERT INTO t VALUES ('hello lan world');",
    );
    expect(store.db.prepare("SELECT count(*) FROM t WHERE t MATCH 'lan'").pluck().get()).toBe(1);
    store.close();
  });
});

describe('settings', () => {
  it('stores JSON values by key', () => {
    const store = Store.open(tempDb());
    expect(store.getSetting('theme')).toBeUndefined();
    store.setSetting('theme', { mode: 'dark' });
    store.setSetting('theme', { mode: 'light' });
    expect(store.getSetting('theme')).toEqual({ mode: 'light' });
    store.close();
  });
});

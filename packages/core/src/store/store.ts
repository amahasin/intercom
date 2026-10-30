import Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.ts';

export interface IdentityRow {
  userId: string;
  publicKey: Buffer;
  certPem: string;
  profileJson: string;
  createdAt: number;
}

/**
 * The profile database. The core is its single writer (plan section 4, rule 2); the UI
 * reads only through queries on the IPC API.
 */
export class Store {
  readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(file: string, migrations: readonly Migration[] = MIGRATIONS): Store {
    const db = new Database(file);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      const store = new Store(db);
      store.migrate(migrations);
      return store;
    } catch (err) {
      // Release the file handle; on Windows an open handle keeps the file locked.
      db.close();
      throw err;
    }
  }

  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private migrate(migrations: readonly Migration[]): void {
    const current = this.schemaVersion;
    const latest = migrations.at(-1)?.version ?? 0;
    if (current > latest) {
      throw new Error(`database schema v${current} is newer than this app (v${latest})`);
    }
    for (const m of migrations) {
      if (m.version <= current) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db.pragma(`user_version = ${m.version}`);
      })();
    }
  }

  getIdentity(): IdentityRow | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id AS userId, public_key AS publicKey, cert_pem AS certPem,
                profile_json AS profileJson, created_at AS createdAt
           FROM identity WHERE id = 1`,
      )
      .get() as IdentityRow | undefined;
    return row;
  }

  insertIdentity(row: IdentityRow): void {
    this.db
      .prepare(
        `INSERT INTO identity (id, user_id, public_key, cert_pem, profile_json, created_at)
         VALUES (1, @userId, @publicKey, @certPem, @profileJson, @createdAt)`,
      )
      .run(row);
  }

  updateProfileJson(profileJson: string): void {
    this.db.prepare('UPDATE identity SET profile_json = ? WHERE id = 1').run(profileJson);
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

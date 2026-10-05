/**
 * Ordered schema migrations. `PRAGMA user_version` records how many have run.
 * Never edit a shipped migration; append a new one.
 *
 * Tables arrive with the milestone that first needs them (plan section 8 lists the full set).
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'identity and settings',
    sql: `
      CREATE TABLE identity (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        user_id      TEXT    NOT NULL,
        public_key   BLOB    NOT NULL,
        cert_pem     TEXT    NOT NULL,
        profile_json TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `,
  },
];

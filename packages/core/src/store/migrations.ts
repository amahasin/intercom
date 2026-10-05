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
  {
    version: 2,
    name: 'peers, direct conversations, event log',
    sql: `
      -- Everyone this PC has seen. The key is pinned on first sight (trust on first use).
      CREATE TABLE peers (
        user_id      TEXT    PRIMARY KEY,
        public_key   BLOB    NOT NULL,
        profile_json TEXT,
        display_name TEXT,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        last_address TEXT,
        last_port    INTEGER,
        trust        TEXT    NOT NULL DEFAULT 'normal' CHECK (trust IN ('normal', 'new-device', 'accepted')),
        verified     INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX peers_display_name ON peers (display_name COLLATE NOCASE);

      CREATE TABLE conversations (
        conv_id       TEXT    PRIMARY KEY,
        kind          TEXT    NOT NULL CHECK (kind IN ('direct', 'group', 'channel', 'team')),
        peer_user_id  TEXT,
        created_at    INTEGER NOT NULL,
        last_activity INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE members (
        conv_id TEXT NOT NULL REFERENCES conversations (conv_id),
        user_id TEXT NOT NULL,
        role    TEXT NOT NULL DEFAULT 'member',
        PRIMARY KEY (conv_id, user_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX members_user ON members (user_id);

      -- The signed log. json is the event exactly as signed, so it can be re-sent verbatim.
      CREATE TABLE events (
        conv_id     TEXT    NOT NULL,
        author      TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        hlc_t       INTEGER NOT NULL,
        hlc_c       INTEGER NOT NULL,
        type        TEXT    NOT NULL,
        json        TEXT    NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (conv_id, author, seq)
      ) STRICT, WITHOUT ROWID;

      -- Materialised from events for fast reads; rebuildable at any time.
      CREATE TABLE messages (
        conv_id TEXT    NOT NULL,
        author  TEXT    NOT NULL,
        seq     INTEGER NOT NULL,
        hlc_t   INTEGER NOT NULL,
        hlc_c   INTEGER NOT NULL,
        text    TEXT    NOT NULL,
        PRIMARY KEY (conv_id, author, seq)
      ) STRICT;
      CREATE INDEX messages_order ON messages (conv_id, hlc_t, hlc_c, author);

      -- What each member is known to hold of each author's events. The outbox is every
      -- own event above a member's acknowledged position.
      CREATE TABLE acks (
        conv_id TEXT    NOT NULL,
        member  TEXT    NOT NULL,
        author  TEXT    NOT NULL,
        upto    INTEGER NOT NULL,
        PRIMARY KEY (conv_id, member, author)
      ) STRICT, WITHOUT ROWID;
    `,
  },
];

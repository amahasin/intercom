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
  {
    version: 3,
    name: 'rich messages, files, activity, search',
    sql: `
      -- Events that act on another message, so a late-arriving post can pick up its edits.
      ALTER TABLE events ADD COLUMN target_author TEXT;
      ALTER TABLE events ADD COLUMN target_seq INTEGER;
      CREATE INDEX events_target ON events (conv_id, target_author, target_seq)
        WHERE target_author IS NOT NULL;

      -- messages.text is the current (edited) Markdown; plain is its searchable text.
      ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
      ALTER TABLE messages ADD COLUMN plain TEXT NOT NULL DEFAULT '';
      ALTER TABLE messages ADD COLUMN body_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE messages ADD COLUMN edited_t INTEGER;
      ALTER TABLE messages ADD COLUMN edited_c INTEGER;
      ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN mentions_me INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
      UPDATE messages SET plain = text;

      -- Last-writer-wins by HLC (then author) per key, so any arrival order converges.
      CREATE TABLE reactions (
        conv_id TEXT NOT NULL, target_author TEXT NOT NULL, target_seq INTEGER NOT NULL,
        user_id TEXT NOT NULL, emoji TEXT NOT NULL, present INTEGER NOT NULL,
        hlc_t INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
        PRIMARY KEY (conv_id, target_author, target_seq, user_id, emoji)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE pins (
        conv_id TEXT NOT NULL, target_author TEXT NOT NULL, target_seq INTEGER NOT NULL,
        pinned INTEGER NOT NULL, by_user TEXT NOT NULL,
        hlc_t INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
        PRIMARY KEY (conv_id, target_author, target_seq)
      ) STRICT, WITHOUT ROWID;

      -- Read receipts received from members (msg.read events).
      CREATE TABLE receipts (
        conv_id TEXT NOT NULL, user_id TEXT NOT NULL,
        hlc_t INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
        PRIMARY KEY (conv_id, user_id)
      ) STRICT, WITHOUT ROWID;

      -- Local only: this PC's read position, saved messages, per-chat notification level.
      CREATE TABLE read_state (
        conv_id TEXT PRIMARY KEY, hlc_t INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
        receipt_sent_t INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE saved (
        conv_id TEXT NOT NULL, author TEXT NOT NULL, seq INTEGER NOT NULL, saved_at INTEGER NOT NULL,
        PRIMARY KEY (conv_id, author, seq)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE conv_settings (conv_id TEXT PRIMARY KEY, notify TEXT NOT NULL) STRICT;

      CREATE TABLE activity (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL, conv_id TEXT NOT NULL, author TEXT NOT NULL,
        target_author TEXT NOT NULL, target_seq INTEGER NOT NULL,
        source_seq INTEGER NOT NULL, emoji TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0,
        UNIQUE (kind, conv_id, author, source_seq, emoji)
      ) STRICT;

      -- Files this PC holds or has seen. have is a bitmap of verified chunks.
      CREATE TABLE files (
        sha256 TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
        manifest TEXT NOT NULL, chunk_count INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('missing', 'partial', 'complete')),
        have BLOB, own INTEGER NOT NULL DEFAULT 0, conv_id TEXT,
        added_at INTEGER NOT NULL, completed_at INTEGER
      ) STRICT;

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        plain, content = 'messages', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO messages_fts (rowid, plain) SELECT rowid, plain FROM messages;
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts (rowid, plain) VALUES (new.rowid, new.plain);
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, plain) VALUES ('delete', old.rowid, old.plain);
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE OF plain ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, plain) VALUES ('delete', old.rowid, old.plain);
        INSERT INTO messages_fts (rowid, plain) VALUES (new.rowid, new.plain);
      END;
    `,
  },
];

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
  {
    version: 4,
    name: 'groups, teams, channels, threads, polls',
    sql: `
      -- Groups and teams have titles; channels belong to a team. meta_json holds derived
      -- state (visibility, description, private, archived), rebuilt from the team log.
      ALTER TABLE conversations ADD COLUMN team_id TEXT;
      ALTER TABLE conversations ADD COLUMN title TEXT;
      ALTER TABLE conversations ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
      CREATE INDEX conversations_team ON conversations (team_id) WHERE team_id IS NOT NULL;

      -- Channel replies point at their root post.
      ALTER TABLE messages ADD COLUMN thread_author TEXT;
      ALTER TABLE messages ADD COLUMN thread_seq INTEGER;
      CREATE INDEX messages_thread ON messages (conv_id, thread_author, thread_seq)
        WHERE thread_author IS NOT NULL;

      -- Latest vote per voter (last writer wins by HLC); a poll's close time.
      CREATE TABLE poll_votes (
        conv_id TEXT NOT NULL, target_author TEXT NOT NULL, target_seq INTEGER NOT NULL,
        voter TEXT NOT NULL, choices_json TEXT NOT NULL,
        hlc_t INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
        PRIMARY KEY (conv_id, target_author, target_seq, voter)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE poll_close (
        conv_id TEXT NOT NULL, target_author TEXT NOT NULL, target_seq INTEGER NOT NULL,
        hlc_t INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
        PRIMARY KEY (conv_id, target_author, target_seq)
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 5,
    name: 'membership events received out of sequence',
    sql: `
      -- Membership and control events that arrived ahead of their author's earlier events
      -- (a former member is sent these, but never the posts in between). They count in
      -- membership timelines; once the gap fills, the event moves to \`events\`.
      CREATE TABLE sparse_events (
        conv_id TEXT    NOT NULL,
        author  TEXT    NOT NULL,
        seq     INTEGER NOT NULL,
        hlc_t   INTEGER NOT NULL,
        hlc_c   INTEGER NOT NULL,
        type    TEXT    NOT NULL,
        json    TEXT    NOT NULL,
        PRIMARY KEY (conv_id, author, seq)
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 6,
    name: 'call history',
    sql: `
      CREATE TABLE calls (
        call_id     TEXT PRIMARY KEY,
        conv_id     TEXT,
        direction   TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
        media       TEXT    NOT NULL CHECK (media IN ('audio', 'video')),
        peers_json  TEXT    NOT NULL,
        started_at  INTEGER NOT NULL,
        answered_at INTEGER,
        ended_at    INTEGER,
        outcome     TEXT
      ) STRICT;
      CREATE INDEX calls_started ON calls (started_at DESC);
    `,
  },
  {
    version: 7,
    name: 'meetings',
    sql: `
      -- Replies to a meeting invitation: the latest per person counts.
      CREATE TABLE meeting_rsvp (
        conv_id TEXT NOT NULL, target_author TEXT NOT NULL, target_seq INTEGER NOT NULL,
        user_id TEXT NOT NULL, response TEXT NOT NULL,
        hlc_t INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
        PRIMARY KEY (conv_id, target_author, target_seq, user_id)
      ) STRICT, WITHOUT ROWID;
      -- Cancellations by the organiser: a whole series (occurrence 0) or one occurrence.
      CREATE TABLE meeting_cancel (
        conv_id TEXT NOT NULL, target_author TEXT NOT NULL, target_seq INTEGER NOT NULL,
        occurrence INTEGER NOT NULL,
        PRIMARY KEY (conv_id, target_author, target_seq, occurrence)
      ) STRICT, WITHOUT ROWID;
      -- Calls announced in a conversation that are over.
      CREATE TABLE call_ended (
        conv_id TEXT NOT NULL, target_author TEXT NOT NULL, target_seq INTEGER NOT NULL,
        PRIMARY KEY (conv_id, target_author, target_seq)
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 8,
    name: 'sealed envelopes',
    sql: `
      -- Other people's envelopes this PC carries (it cannot read them), up to 50 MB.
      CREATE TABLE envelopes (
        id          TEXT    PRIMARY KEY,
        to_user     TEXT    NOT NULL,
        from_user   TEXT    NOT NULL,
        json        TEXT    NOT NULL,
        bytes       INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX envelopes_to ON envelopes (to_user);
      CREATE INDEX envelopes_expiry ON envelopes (expires_at);
      -- Own direct-chat events sealed for an offline recipient, and who carries them.
      CREATE TABLE envelopes_out (
        id            TEXT    PRIMARY KEY,
        conv_id       TEXT    NOT NULL,
        seq           INTEGER NOT NULL,
        to_user       TEXT    NOT NULL,
        json          TEXT    NOT NULL,
        carriers_json TEXT    NOT NULL DEFAULT '[]',
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX envelopes_out_conv ON envelopes_out (conv_id, seq);
    `,
  },
];

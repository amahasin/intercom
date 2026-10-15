import type Database from 'better-sqlite3';
import type { ConversationKind, Hlc } from '@officemesh/protocol';

export interface ConversationRow {
  convId: string;
  kind: ConversationKind;
  peerUserId: string | null;
  createdAt: number;
  lastActivity: number;
  teamId: string | null;
  title: string | null;
  metaJson: string;
}

export interface ConversationSummaryRow extends ConversationRow {
  lastAuthor: string | null;
  lastText: string | null;
  lastAt: number | null;
}

export interface StoredEvent {
  convId: string;
  author: string;
  seq: number;
  hlc: Hlc;
  type: string;
  json: string;
  target?: { author: string; seq: number } | undefined;
}

const CONV_COLUMNS = `conv_id AS convId, kind, peer_user_id AS peerUserId,
  created_at AS createdAt, last_activity AS lastActivity, team_id AS teamId, title,
  meta_json AS metaJson`;

/** Conversations, membership, the signed event log, materialised messages and acks. */
export class ConversationRepo {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  get(convId: string): ConversationRow | undefined {
    return this.db
      .prepare(`SELECT ${CONV_COLUMNS} FROM conversations WHERE conv_id = ?`)
      .get(convId) as ConversationRow | undefined;
  }

  list(): ConversationSummaryRow[] {
    return this.db
      .prepare(
        `SELECT ${CONV_COLUMNS.replace(/(^|,\s*)(\w+)/g, '$1c.$2')},
                m.author AS lastAuthor, m.plain AS lastText, m.hlc_t AS lastAt
           FROM conversations c
           LEFT JOIN messages m ON m.rowid = (
             SELECT rowid FROM messages WHERE conv_id = c.conv_id AND deleted = 0
              ORDER BY hlc_t DESC, hlc_c DESC, author DESC LIMIT 1)
          ORDER BY c.last_activity DESC`,
      )
      .all() as ConversationSummaryRow[];
  }

  createDirect(convId: string, selfId: string, peerId: string, now: number): ConversationRow {
    const row = { convId, kind: 'direct', peerUserId: peerId, createdAt: now, lastActivity: now };
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO conversations (conv_id, kind, peer_user_id, created_at, last_activity)
           VALUES (@convId, @kind, @peerUserId, @createdAt, @lastActivity)`,
        )
        .run(row);
      const add = this.db.prepare('INSERT OR IGNORE INTO members (conv_id, user_id) VALUES (?, ?)');
      add.run(convId, selfId);
      add.run(convId, peerId);
    });
    return this.get(convId)!;
  }

  /**
   * The broadcast channel (see sync/broadcast.ts): made on first use, the same everywhere. It is
   * kept as a group with a mark in its details, so the tables need no new kind.
   */
  ensureBroadcast(convId: string, now: number): ConversationRow {
    return (
      this.get(convId) ??
      this.createConversation(
        convId,
        'group',
        { title: 'Broadcast', meta: { broadcast: true } },
        now,
      )
    );
  }

  /** Add one person to a conversation's members; true when they were not in it. */
  addMember(convId: string, userId: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO members (conv_id, user_id, role) VALUES (?, ?, 'member')")
        .run(convId, userId).changes > 0
    );
  }

  /** A group, team or channel; its members are written separately from the log. */
  createConversation(
    convId: string,
    kind: 'group' | 'team' | 'channel',
    fields: {
      teamId?: string | undefined;
      title?: string | undefined;
      meta?: Record<string, unknown>;
    },
    now: number,
  ): ConversationRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversations (conv_id, kind, created_at, last_activity, team_id, title, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        convId,
        kind,
        now,
        now,
        fields.teamId ?? null,
        fields.title ?? null,
        JSON.stringify(fields.meta ?? {}),
      );
    return this.get(convId)!;
  }

  /** Update derived title and metadata; true when something changed. */
  updateDerived(convId: string, title: string | null, meta: Record<string, unknown>): boolean {
    return (
      this.db
        .prepare(
          `UPDATE conversations SET title = ?, meta_json = ?
            WHERE conv_id = ? AND (title IS NOT ? OR meta_json <> ?)`,
        )
        .run(title, JSON.stringify(meta), convId, title, JSON.stringify(meta)).changes > 0
    );
  }

  /** Replace a conversation's current members (derived from its membership timeline). */
  setMembers(convId: string, members: Map<string, 'owner' | 'member'>): boolean {
    const before = JSON.stringify(this.memberRoles(convId));
    this.transaction(() => {
      this.db.prepare('DELETE FROM members WHERE conv_id = ?').run(convId);
      const add = this.db.prepare('INSERT INTO members (conv_id, user_id, role) VALUES (?, ?, ?)');
      for (const [userId, role] of members) add.run(convId, userId, role);
    });
    return JSON.stringify(this.memberRoles(convId)) !== before;
  }

  memberRoles(convId: string): Array<{ userId: string; role: 'owner' | 'member' }> {
    return this.db
      .prepare('SELECT user_id AS userId, role FROM members WHERE conv_id = ? ORDER BY user_id')
      .all(convId) as Array<{ userId: string; role: 'owner' | 'member' }>;
  }

  channelsOf(teamId: string): ConversationRow[] {
    return this.db
      .prepare(`SELECT ${CONV_COLUMNS} FROM conversations WHERE team_id = ? ORDER BY created_at`)
      .all(teamId) as ConversationRow[];
  }

  /** Ids of every group, team and channel held here. */
  multiParty(): string[] {
    return this.db
      .prepare(`SELECT conv_id FROM conversations WHERE kind != 'direct'`)
      .pluck()
      .all() as string[];
  }

  byKind(kind: string): ConversationRow[] {
    return this.db
      .prepare(`SELECT ${CONV_COLUMNS} FROM conversations WHERE kind = ?`)
      .all(kind) as ConversationRow[];
  }

  /** Raw JSON of a conversation's events of some types, in HLC order. */
  eventsOfTypes(convId: string, types: string[]): string[] {
    const list = types.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT json, hlc_t, hlc_c, author, seq FROM events WHERE conv_id = ? AND type IN (${list})
         UNION ALL
         SELECT json, hlc_t, hlc_c, author, seq FROM sparse_events WHERE conv_id = ? AND type IN (${list})
          ORDER BY hlc_t, hlc_c, author, seq`,
      )
      .pluck()
      .all(convId, ...types, convId, ...types) as string[];
  }

  /** Keep a membership event that arrived before its author's earlier events. */
  insertSparse(
    ev: {
      convId: string;
      author: string;
      seq: number;
      hlc: { t: number; c: number };
      type: string;
    },
    json: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO sparse_events (conv_id, author, seq, hlc_t, hlc_c, type, json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ev.convId, ev.author, ev.seq, ev.hlc.t, ev.hlc.c, ev.type, json).changes > 0
    );
  }

  /** Stored events of some types with `after` < HLC <= `upto`. */
  eventsInHlcRange(
    convId: string,
    types: string[],
    after: { t: number; c: number },
    upto: { t: number; c: number },
  ): string[] {
    return this.db
      .prepare(
        `SELECT json FROM events WHERE conv_id = ? AND type IN (${types.map(() => '?').join(',')})
           AND (hlc_t > ? OR (hlc_t = ? AND hlc_c > ?))
           AND (hlc_t < ? OR (hlc_t = ? AND hlc_c <= ?))
         ORDER BY author, seq`,
      )
      .pluck()
      .all(convId, ...types, after.t, after.t, after.c, upto.t, upto.t, upto.c) as string[];
  }

  /** All of one conversation's events in HLC order, paged (for re-materialising it). */
  *conversationEvents(convId: string, pageSize = 2_000): Generator<string> {
    const next = this.db.prepare(
      `SELECT json, hlc_t, hlc_c, author, seq FROM events
        WHERE conv_id = ? AND (hlc_t, hlc_c, author, seq) > (?, ?, ?, ?)
        ORDER BY hlc_t, hlc_c, author, seq LIMIT ?`,
    );
    type Row = { json: string; hlc_t: number; hlc_c: number; author: string; seq: number };
    let page = next.all(convId, -1, -1, '', -1, pageSize) as Row[];
    while (page.length > 0) {
      for (const row of page) yield row.json;
      const last = page.at(-1)!;
      page = next.all(convId, last.hlc_t, last.hlc_c, last.author, last.seq, pageSize) as Row[];
    }
  }

  touch(convId: string, at: number): void {
    this.db
      .prepare('UPDATE conversations SET last_activity = MAX(last_activity, ?) WHERE conv_id = ?')
      .run(at, convId);
  }

  members(convId: string): string[] {
    return this.db
      .prepare('SELECT user_id FROM members WHERE conv_id = ?')
      .pluck()
      .all(convId) as string[];
  }

  isMember(convId: string, userId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM members WHERE conv_id = ? AND user_id = ?')
        .get(convId, userId) !== undefined
    );
  }

  /**
   * Conversations both this PC's user and `userId` currently belong to. After a removal
   * neither side syncs that conversation with the other any more.
   */
  sharedWith(userId: string, selfId?: string): string[] {
    if (!selfId) {
      return this.db
        .prepare('SELECT conv_id FROM members WHERE user_id = ?')
        .pluck()
        .all(userId) as string[];
    }
    return this.db
      .prepare(
        `SELECT a.conv_id FROM members a JOIN members b ON b.conv_id = a.conv_id
          WHERE a.user_id = ? AND b.user_id = ?`,
      )
      .pluck()
      .all(userId, selfId) as string[];
  }

  /**
   * True when `member` may lack some event this PC holds in a conversation they share:
   * for any author other than the member, the head here is above what they acknowledged.
   */
  hasAnyUnacked(member: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM members m
             JOIN (SELECT conv_id, author, MAX(seq) AS h FROM events GROUP BY conv_id, author) e
               ON e.conv_id = m.conv_id AND e.author <> m.user_id
             LEFT JOIN acks a ON a.conv_id = m.conv_id AND a.member = m.user_id AND a.author = e.author
            WHERE m.user_id = ? AND e.h > COALESCE(a.upto, 0)
            LIMIT 1`,
        )
        .get(member) !== undefined
    );
  }

  /** Highest stored seq per author. Gaps are never stored, so this is the contiguous head. */
  heads(convId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT author, MAX(seq) AS seq FROM events WHERE conv_id = ? GROUP BY author')
      .all(convId) as Array<{ author: string; seq: number }>;
    return Object.fromEntries(rows.map((r) => [r.author, r.seq]));
  }

  head(convId: string, author: string): number {
    return (
      (this.db
        .prepare('SELECT MAX(seq) FROM events WHERE conv_id = ? AND author = ?')
        .pluck()
        .get(convId, author) as number | null) ?? 0
    );
  }

  insertEvent(ev: StoredEvent, receivedAt: number): void {
    this.db
      .prepare('DELETE FROM sparse_events WHERE conv_id = ? AND author = ? AND seq = ?')
      .run(ev.convId, ev.author, ev.seq);
    this.db
      .prepare(
        `INSERT INTO events (conv_id, author, seq, hlc_t, hlc_c, type, json, received_at, target_author, target_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.convId,
        ev.author,
        ev.seq,
        ev.hlc.t,
        ev.hlc.c,
        ev.type,
        ev.json,
        receivedAt,
        ev.target?.author ?? null,
        ev.target?.seq ?? null,
      );
  }

  /** Raw JSON of stored events of `types` that act on one message, in HLC order. */
  targeting(convId: string, target: { author: string; seq: number }, types: string[]): string[] {
    return this.db
      .prepare(
        `SELECT json FROM events WHERE conv_id = ? AND target_author = ? AND target_seq = ?
            AND type IN (${types.map(() => '?').join(',')}) ORDER BY hlc_t, hlc_c, author`,
      )
      .pluck()
      .all(convId, target.author, target.seq, ...types) as string[];
  }

  /**
   * Every stored event in HLC display order (for rebuild), in pages, so the caller may
   * write between pages (better-sqlite3 forbids writes while a statement is iterating).
   */
  *allEvents(pageSize = 2_000): Generator<string> {
    const first = this.db.prepare(
      'SELECT json, hlc_t, hlc_c, author, seq FROM events ORDER BY hlc_t, hlc_c, author, seq LIMIT ?',
    );
    const next = this.db.prepare(
      `SELECT json, hlc_t, hlc_c, author, seq FROM events WHERE (hlc_t, hlc_c, author, seq) > (?, ?, ?, ?)
        ORDER BY hlc_t, hlc_c, author, seq LIMIT ?`,
    );
    type Row = { json: string; hlc_t: number; hlc_c: number; author: string; seq: number };
    let page = first.all(pageSize) as Row[];
    while (page.length > 0) {
      for (const row of page) yield row.json;
      const last = page.at(-1)!;
      page = next.all(last.hlc_t, last.hlc_c, last.author, last.seq, pageSize) as Row[];
    }
  }

  /** Raw event JSON for `author` after `afterSeq`, in seq order. */
  /** Events by `author` after `afterSeq`, optionally only those at or before HLC `upto`. */
  eventsAfter(
    convId: string,
    author: string,
    afterSeq: number,
    limit: number,
    upto?: { t: number; c: number },
  ): string[] {
    if (upto) {
      return this.db
        .prepare(
          `SELECT json FROM events WHERE conv_id = ? AND author = ? AND seq > ?
             AND (hlc_t < ? OR (hlc_t = ? AND hlc_c <= ?)) ORDER BY seq LIMIT ?`,
        )
        .pluck()
        .all(convId, author, afterSeq, upto.t, upto.t, upto.c, limit) as string[];
    }
    return this.db
      .prepare(
        'SELECT json FROM events WHERE conv_id = ? AND author = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .pluck()
      .all(convId, author, afterSeq, limit) as string[];
  }

  getAck(convId: string, member: string, author: string): number {
    return (
      (this.db
        .prepare('SELECT upto FROM acks WHERE conv_id = ? AND member = ? AND author = ?')
        .pluck()
        .get(convId, member, author) as number | undefined) ?? 0
    );
  }

  /** Raise an ack; returns the previous value, or undefined when it did not move. */
  raiseAck(convId: string, member: string, author: string, upto: number): number | undefined {
    const prev = this.getAck(convId, member, author);
    if (upto <= prev) return undefined;
    this.db
      .prepare(
        `INSERT INTO acks (conv_id, member, author, upto) VALUES (?, ?, ?, ?)
         ON CONFLICT (conv_id, member, author) DO UPDATE SET upto = excluded.upto`,
      )
      .run(convId, member, author, upto);
    return prev;
  }

  /** Note when `member` acknowledged own events up to `upto` (see migration 16). */
  logAck(convId: string, member: string, upto: number, at: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO ack_log (conv_id, member, upto, at) VALUES (?, ?, ?, ?)')
      .run(convId, member, upto, at);
  }

  /** When `member` first acknowledged own event `seq` (undefined: not kept, or not yet). */
  deliveredAt(convId: string, member: string, seq: number): number | undefined {
    return this.db
      .prepare(
        `SELECT at FROM ack_log WHERE conv_id = ? AND member = ? AND upto >= ?
          ORDER BY upto LIMIT 1`,
      )
      .pluck()
      .get(convId, member, seq) as number | undefined;
  }

  /**
   * When `member`'s PC first said it had read up to a message (its read receipt's own time), or
   * undefined. Receipts are events, so this works for messages from before the ack log.
   */
  readAt(convId: string, member: string, hlc: { t: number; c: number }): number | undefined {
    return this.db
      .prepare(
        `SELECT hlc_t FROM events
          WHERE conv_id = @convId AND author = @member AND type = 'msg.read'
            AND (json_extract(json, '$.body.upto.t') > @t
                 OR (json_extract(json, '$.body.upto.t') = @t
                     AND json_extract(json, '$.body.upto.c') >= @c))
          ORDER BY seq LIMIT 1`,
      )
      .pluck()
      .get({ convId, member, t: hlc.t, c: hlc.c }) as number | undefined;
  }

  /** True when `member` has not acknowledged some event `author` wrote in a shared conversation. */
  hasUnacked(member: string, author: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM members m
             JOIN (SELECT conv_id, MAX(seq) AS h FROM events WHERE author = @author GROUP BY conv_id) e
               ON e.conv_id = m.conv_id
             LEFT JOIN acks a ON a.conv_id = m.conv_id AND a.member = m.user_id AND a.author = @author
            WHERE m.user_id = @member AND e.h > COALESCE(a.upto, 0)
            LIMIT 1`,
        )
        .get({ member, author }) !== undefined
    );
  }
}

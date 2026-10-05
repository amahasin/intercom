import type Database from 'better-sqlite3';
import type { ConversationKind, Hlc } from '@officemesh/protocol';

export interface ConversationRow {
  convId: string;
  kind: ConversationKind;
  peerUserId: string | null;
  createdAt: number;
  lastActivity: number;
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
}

export interface MessageRow {
  convId: string;
  author: string;
  seq: number;
  hlcT: number;
  hlcC: number;
  text: string;
}

const CONV_COLUMNS = `conv_id AS convId, kind, peer_user_id AS peerUserId,
  created_at AS createdAt, last_activity AS lastActivity`;
const MSG_COLUMNS = 'conv_id AS convId, author, seq, hlc_t AS hlcT, hlc_c AS hlcC, text';

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
        `SELECT ${CONV_COLUMNS.replaceAll('conv_id', 'c.conv_id')},
                m.author AS lastAuthor, m.text AS lastText, m.hlc_t AS lastAt
           FROM conversations c
           LEFT JOIN messages m ON m.rowid = (
             SELECT rowid FROM messages WHERE conv_id = c.conv_id
              ORDER BY hlc_t DESC, hlc_c DESC, author DESC LIMIT 1)
          ORDER BY c.last_activity DESC`,
      )
      .all() as ConversationSummaryRow[];
  }

  createDirect(convId: string, selfId: string, peerId: string, now: number): ConversationRow {
    const row: ConversationRow = {
      convId,
      kind: 'direct',
      peerUserId: peerId,
      createdAt: now,
      lastActivity: now,
    };
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

  /** Conversations both this PC and `userId` belong to (this PC is a member of all it holds). */
  sharedWith(userId: string): string[] {
    return this.db
      .prepare('SELECT conv_id FROM members WHERE user_id = ?')
      .pluck()
      .all(userId) as string[];
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
      .prepare(
        `INSERT INTO events (conv_id, author, seq, hlc_t, hlc_c, type, json, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ev.convId, ev.author, ev.seq, ev.hlc.t, ev.hlc.c, ev.type, ev.json, receivedAt);
  }

  /** Raw event JSON for `author` after `afterSeq`, in seq order. */
  eventsAfter(convId: string, author: string, afterSeq: number, limit: number): string[] {
    return this.db
      .prepare(
        'SELECT json FROM events WHERE conv_id = ? AND author = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .pluck()
      .all(convId, author, afterSeq, limit) as string[];
  }

  insertMessage(row: MessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages (conv_id, author, seq, hlc_t, hlc_c, text)
         VALUES (@convId, @author, @seq, @hlcT, @hlcC, @text)`,
      )
      .run(row);
  }

  /** Messages in display order (hlc, then author), newest `limit` before the cursor. */
  messages(convId: string, limit: number, before?: { hlc: Hlc; author: string }): MessageRow[] {
    const rows = before
      ? this.db
          .prepare(
            `SELECT ${MSG_COLUMNS} FROM messages
              WHERE conv_id = ? AND (hlc_t, hlc_c, author) < (?, ?, ?)
              ORDER BY hlc_t DESC, hlc_c DESC, author DESC LIMIT ?`,
          )
          .all(convId, before.hlc.t, before.hlc.c, before.author, limit)
      : this.db
          .prepare(
            `SELECT ${MSG_COLUMNS} FROM messages WHERE conv_id = ?
              ORDER BY hlc_t DESC, hlc_c DESC, author DESC LIMIT ?`,
          )
          .all(convId, limit);
    return (rows as MessageRow[]).reverse();
  }

  messagesByAuthorRange(
    convId: string,
    author: string,
    fromSeq: number,
    toSeq: number,
  ): MessageRow[] {
    return this.db
      .prepare(
        `SELECT ${MSG_COLUMNS} FROM messages WHERE conv_id = ? AND author = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
      )
      .all(convId, author, fromSeq, toSeq) as MessageRow[];
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

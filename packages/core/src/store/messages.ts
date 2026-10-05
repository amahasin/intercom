import type Database from 'better-sqlite3';
import type { Hlc, MsgRef } from '@officemesh/protocol';

export interface MessageRow {
  convId: string;
  author: string;
  seq: number;
  hlcT: number;
  hlcC: number;
  kind: 'text' | 'file' | 'poll';
  /** Current Markdown (after edits; empty once deleted). */
  text: string;
  plain: string;
  /** The post's body without `text` (mentions, replyTo, file, preview, ...). */
  bodyJson: string;
  editedT: number | null;
  editedC: number | null;
  deleted: number;
  mentionsMe: number;
  urgent: number;
  threadAuthor: string | null;
  threadSeq: number | null;
}

export interface ReactionRow {
  targetAuthor: string;
  targetSeq: number;
  userId: string;
  emoji: string;
}

export interface ActivityRow {
  id: number;
  kind: 'mention' | 'reply' | 'reaction';
  convId: string;
  author: string;
  targetAuthor: string;
  targetSeq: number;
  sourceSeq: number;
  emoji: string;
  at: number;
  read: number;
}

const MSG = `conv_id AS convId, author, seq, hlc_t AS hlcT, hlc_c AS hlcC, kind, text, plain,
  body_json AS bodyJson, edited_t AS editedT, edited_c AS editedC, deleted,
  mentions_me AS mentionsMe, urgent, thread_author AS threadAuthor, thread_seq AS threadSeq`;

/** Is (t, c, a) strictly newer than (t2, c2, a2)? HLC order with author as the tie-break. */
export function newer(
  a: { t: number; c: number; author: string },
  b: { t: number; c: number; author: string },
): boolean {
  return a.t !== b.t ? a.t > b.t : a.c !== b.c ? a.c > b.c : a.author > b.author;
}

/** Materialised messages and everything hanging off them: reactions, pins, receipts, read state. */
export class MessageRepo {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insert(row: MessageRow): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO messages (conv_id, author, seq, hlc_t, hlc_c, kind, text, plain, body_json,
                                           edited_t, edited_c, deleted, mentions_me, urgent, thread_author, thread_seq)
           VALUES (@convId, @author, @seq, @hlcT, @hlcC, @kind, @text, @plain, @bodyJson,
                   @editedT, @editedC, @deleted, @mentionsMe, @urgent, @threadAuthor, @threadSeq)`,
        )
        .run(row).changes > 0
    );
  }

  get(convId: string, ref: MsgRef): MessageRow | undefined {
    return this.db
      .prepare(`SELECT ${MSG} FROM messages WHERE conv_id = ? AND author = ? AND seq = ?`)
      .get(convId, ref.author, ref.seq) as MessageRow | undefined;
  }

  /** Apply an edit if it is newer than the last one; returns true when the row changed. */
  edit(
    convId: string,
    ref: MsgRef,
    text: string,
    plain: string,
    bodyJson: string,
    mentionsMe: boolean,
    at: Hlc,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE messages SET text = ?, plain = ?, body_json = ?, mentions_me = ?, edited_t = ?, edited_c = ?
            WHERE conv_id = ? AND author = ? AND seq = ? AND deleted = 0
              AND (edited_t IS NULL OR edited_t < ? OR (edited_t = ? AND edited_c < ?))`,
        )
        .run(
          text,
          plain,
          bodyJson,
          mentionsMe ? 1 : 0,
          at.t,
          at.c,
          convId,
          ref.author,
          ref.seq,
          at.t,
          at.t,
          at.c,
        ).changes > 0
    );
  }

  markDeleted(convId: string, ref: MsgRef): boolean {
    return (
      this.db
        .prepare(
          `UPDATE messages SET deleted = 1, text = '', plain = '', body_json = '{}', mentions_me = 0
            WHERE conv_id = ? AND author = ? AND seq = ? AND deleted = 0`,
        )
        .run(convId, ref.author, ref.seq).changes > 0
    );
  }

  /** Newest `limit` messages before the cursor, returned in display order. */
  list(convId: string, limit: number, before?: { hlc: Hlc; author: string }): MessageRow[] {
    const rows = before
      ? this.db
          .prepare(
            `SELECT ${MSG} FROM messages WHERE conv_id = ? AND (hlc_t, hlc_c, author) < (?, ?, ?)
              ORDER BY hlc_t DESC, hlc_c DESC, author DESC LIMIT ?`,
          )
          .all(convId, before.hlc.t, before.hlc.c, before.author, limit)
      : this.db
          .prepare(
            `SELECT ${MSG} FROM messages WHERE conv_id = ? ORDER BY hlc_t DESC, hlc_c DESC, author DESC LIMIT ?`,
          )
          .all(convId, limit);
    return (rows as MessageRow[]).reverse();
  }

  /** `count` messages each side of one message, in display order. */
  context(convId: string, ref: MsgRef, count: number): MessageRow[] {
    const center = this.get(convId, ref);
    if (!center) return [];
    const before = this.db
      .prepare(
        `SELECT ${MSG} FROM messages WHERE conv_id = ? AND (hlc_t, hlc_c, author) < (?, ?, ?)
          ORDER BY hlc_t DESC, hlc_c DESC, author DESC LIMIT ?`,
      )
      .all(convId, center.hlcT, center.hlcC, center.author, count) as MessageRow[];
    const after = this.db
      .prepare(
        `SELECT ${MSG} FROM messages WHERE conv_id = ? AND (hlc_t, hlc_c, author) > (?, ?, ?)
          ORDER BY hlc_t, hlc_c, author LIMIT ?`,
      )
      .all(convId, center.hlcT, center.hlcC, center.author, count) as MessageRow[];
    return [...before.reverse(), center, ...after];
  }

  byKeys(convId: string, refs: MsgRef[]): MessageRow[] {
    const stmt = this.db.prepare(
      `SELECT ${MSG} FROM messages WHERE conv_id = ? AND author = ? AND seq = ?`,
    );
    return refs.flatMap((r) => {
      const row = stmt.get(convId, r.author, r.seq) as MessageRow | undefined;
      return row ? [row] : [];
    });
  }

  /** Own messages with HLC in (from, to] (status changes after a read receipt). */
  byAuthorInHlcRange(convId: string, author: string, from: Hlc, to: Hlc): MessageRow[] {
    return this.db
      .prepare(
        `SELECT ${MSG} FROM messages WHERE conv_id = ? AND author = ?
            AND (hlc_t, hlc_c) > (?, ?) AND (hlc_t, hlc_c) <= (?, ?) ORDER BY hlc_t, hlc_c`,
      )
      .all(convId, author, from.t, from.c, to.t, to.c) as MessageRow[];
  }

  byAuthorSeqRange(convId: string, author: string, fromSeq: number, toSeq: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT ${MSG} FROM messages WHERE conv_id = ? AND author = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
      )
      .all(convId, author, fromSeq, toSeq) as MessageRow[];
  }

  latest(convId: string): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT ${MSG} FROM messages WHERE conv_id = ? ORDER BY hlc_t DESC, hlc_c DESC, author DESC LIMIT 1`,
      )
      .get(convId) as MessageRow | undefined;
  }

  // ---------------------------------------------------------------------------
  // Reactions and pins (last writer wins)
  // ---------------------------------------------------------------------------

  setReaction(
    convId: string,
    target: MsgRef,
    userId: string,
    emoji: string,
    present: boolean,
    at: Hlc,
  ): boolean {
    const cur = this.db
      .prepare(
        `SELECT hlc_t AS t, hlc_c AS c FROM reactions
          WHERE conv_id = ? AND target_author = ? AND target_seq = ? AND user_id = ? AND emoji = ?`,
      )
      .get(convId, target.author, target.seq, userId, emoji) as
      { t: number; c: number } | undefined;
    // Same user for every write to this key, so (t, c) alone orders them.
    if (cur && (cur.t > at.t || (cur.t === at.t && cur.c >= at.c))) return false;
    this.db
      .prepare(
        `INSERT INTO reactions (conv_id, target_author, target_seq, user_id, emoji, present, hlc_t, hlc_c)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET present = excluded.present, hlc_t = excluded.hlc_t, hlc_c = excluded.hlc_c`,
      )
      .run(convId, target.author, target.seq, userId, emoji, present ? 1 : 0, at.t, at.c);
    return true;
  }

  reactions(convId: string, refs: MsgRef[]): ReactionRow[] {
    if (refs.length === 0) return [];
    const stmt = this.db.prepare(
      `SELECT target_author AS targetAuthor, target_seq AS targetSeq, user_id AS userId, emoji
         FROM reactions WHERE conv_id = ? AND target_author = ? AND target_seq = ? AND present = 1
        ORDER BY hlc_t, hlc_c`,
    );
    return refs.flatMap((r) => stmt.all(convId, r.author, r.seq) as ReactionRow[]);
  }

  setPin(convId: string, target: MsgRef, pinned: boolean, by: string, at: Hlc): boolean {
    const cur = this.db
      .prepare(
        'SELECT hlc_t AS t, hlc_c AS c, by_user AS author FROM pins WHERE conv_id = ? AND target_author = ? AND target_seq = ?',
      )
      .get(convId, target.author, target.seq) as
      { t: number; c: number; author: string } | undefined;
    if (cur && !newer({ ...at, author: by }, cur)) return false;
    this.db
      .prepare(
        `INSERT INTO pins (conv_id, target_author, target_seq, pinned, by_user, hlc_t, hlc_c) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET pinned = excluded.pinned, by_user = excluded.by_user,
           hlc_t = excluded.hlc_t, hlc_c = excluded.hlc_c`,
      )
      .run(convId, target.author, target.seq, pinned ? 1 : 0, by, at.t, at.c);
    return true;
  }

  pinned(convId: string): MsgRef[] {
    return this.db
      .prepare(
        'SELECT target_author AS author, target_seq AS seq FROM pins WHERE conv_id = ? AND pinned = 1 ORDER BY hlc_t DESC',
      )
      .all(convId) as MsgRef[];
  }

  isPinned(convId: string, ref: MsgRef): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM pins WHERE conv_id = ? AND target_author = ? AND target_seq = ? AND pinned = 1',
        )
        .get(convId, ref.author, ref.seq) !== undefined
    );
  }

  // ---------------------------------------------------------------------------
  // Read receipts and this PC's read position
  // ---------------------------------------------------------------------------

  /** Raise a member's read receipt; returns the previous position when it moved. */
  raiseReceipt(convId: string, userId: string, upto: Hlc): Hlc | undefined {
    const prev = this.receipt(convId, userId);
    if (prev && (prev.t > upto.t || (prev.t === upto.t && prev.c >= upto.c))) return undefined;
    this.db
      .prepare(
        `INSERT INTO receipts (conv_id, user_id, hlc_t, hlc_c) VALUES (?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET hlc_t = excluded.hlc_t, hlc_c = excluded.hlc_c`,
      )
      .run(convId, userId, upto.t, upto.c);
    return prev ?? { t: 0, c: 0 };
  }

  receipt(convId: string, userId: string): Hlc | undefined {
    return this.db
      .prepare('SELECT hlc_t AS t, hlc_c AS c FROM receipts WHERE conv_id = ? AND user_id = ?')
      .get(convId, userId) as Hlc | undefined;
  }

  readState(convId: string): { hlc: Hlc; receiptSentT: number } | undefined {
    const row = this.db
      .prepare(
        'SELECT hlc_t AS t, hlc_c AS c, receipt_sent_t AS sent FROM read_state WHERE conv_id = ?',
      )
      .get(convId) as { t: number; c: number; sent: number } | undefined;
    return row && { hlc: { t: row.t, c: row.c }, receiptSentT: row.sent };
  }

  setReadState(convId: string, hlc: Hlc): void {
    this.db
      .prepare(
        `INSERT INTO read_state (conv_id, hlc_t, hlc_c) VALUES (?, ?, ?)
         ON CONFLICT DO UPDATE SET hlc_t = MAX(hlc_t, excluded.hlc_t),
           hlc_c = CASE WHEN excluded.hlc_t > hlc_t THEN excluded.hlc_c
                        WHEN excluded.hlc_t = hlc_t THEN MAX(hlc_c, excluded.hlc_c) ELSE hlc_c END`,
      )
      .run(convId, hlc.t, hlc.c);
  }

  setReceiptSent(convId: string, t: number): void {
    this.db.prepare('UPDATE read_state SET receipt_sent_t = ? WHERE conv_id = ?').run(t, convId);
  }

  /** Messages from others after this PC's read position, not deleted. */
  unread(convId: string, selfId: string): number {
    const rs = this.readState(convId)?.hlc ?? { t: 0, c: 0 };
    return this.db
      .prepare(
        `SELECT count(*) FROM messages WHERE conv_id = ? AND author <> ? AND deleted = 0
            AND (hlc_t, hlc_c) > (?, ?)`,
      )
      .pluck()
      .get(convId, selfId, rs.t, rs.c) as number;
  }

  // ---------------------------------------------------------------------------
  // Local: saved messages, notification level
  // ---------------------------------------------------------------------------

  setSaved(convId: string, ref: MsgRef, on: boolean, now: number): void {
    if (on) {
      this.db
        .prepare('INSERT OR IGNORE INTO saved (conv_id, author, seq, saved_at) VALUES (?, ?, ?, ?)')
        .run(convId, ref.author, ref.seq, now);
    } else {
      this.db
        .prepare('DELETE FROM saved WHERE conv_id = ? AND author = ? AND seq = ?')
        .run(convId, ref.author, ref.seq);
    }
  }

  isSaved(convId: string, ref: MsgRef): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM saved WHERE conv_id = ? AND author = ? AND seq = ?')
        .get(convId, ref.author, ref.seq) !== undefined
    );
  }

  saved(): Array<{ convId: string; author: string; seq: number }> {
    return this.db
      .prepare('SELECT conv_id AS convId, author, seq FROM saved ORDER BY saved_at DESC LIMIT 500')
      .all() as Array<{ convId: string; author: string; seq: number }>;
  }

  notifyLevel(convId: string): 'all' | 'mentions' | 'muted' | undefined {
    return this.db
      .prepare('SELECT notify FROM conv_settings WHERE conv_id = ?')
      .pluck()
      .get(convId) as 'all' | 'mentions' | 'muted' | undefined;
  }

  setNotifyLevel(convId: string, level: 'all' | 'mentions' | 'muted'): void {
    this.db
      .prepare(
        'INSERT INTO conv_settings (conv_id, notify) VALUES (?, ?) ON CONFLICT DO UPDATE SET notify = excluded.notify',
      )
      .run(convId, level);
  }

  // ---------------------------------------------------------------------------
  // Activity
  // ---------------------------------------------------------------------------

  addActivity(a: Omit<ActivityRow, 'id' | 'read'>): number | undefined {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO activity (kind, conv_id, author, target_author, target_seq, source_seq, emoji, at)
         VALUES (@kind, @convId, @author, @targetAuthor, @targetSeq, @sourceSeq, @emoji, @at)`,
      )
      .run(a);
    return res.changes > 0 ? Number(res.lastInsertRowid) : undefined;
  }

  activity(limit = 200): ActivityRow[] {
    return this.db
      .prepare(
        `SELECT id, kind, conv_id AS convId, author, target_author AS targetAuthor, target_seq AS targetSeq,
                source_seq AS sourceSeq, emoji, at, read
           FROM activity ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as ActivityRow[];
  }

  markActivityRead(ids?: number[]): void {
    if (!ids) {
      this.db.prepare('UPDATE activity SET read = 1 WHERE read = 0').run();
      return;
    }
    const stmt = this.db.prepare('UPDATE activity SET read = 1 WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }

  unreadActivity(): number {
    return this.db.prepare('SELECT count(*) FROM activity WHERE read = 0').pluck().get() as number;
  }

  // ---------------------------------------------------------------------------
  // Search and rebuild
  // ---------------------------------------------------------------------------

  search(q: {
    match: string | undefined;
    from?: string | undefined;
    convId?: string | undefined;
    hasFile?: boolean | undefined;
    after?: number | undefined;
    before?: number | undefined;
    limit: number;
  }): Array<MessageRow & { snippet: string }> {
    const where: string[] = ['m.deleted = 0'];
    const args: unknown[] = [];
    let from = 'messages m';
    let snippet = 'substr(m.plain, 1, 160)';
    if (q.match) {
      from = 'messages_fts JOIN messages m ON m.rowid = messages_fts.rowid';
      where.push('messages_fts MATCH ?');
      args.push(q.match);
      snippet = "snippet(messages_fts, 0, char(1), char(2), '…', 16)";
    }
    if (q.from) {
      where.push('m.author = ?');
      args.push(q.from);
    }
    if (q.convId) {
      where.push('m.conv_id = ?');
      args.push(q.convId);
    }
    if (q.hasFile) where.push("m.kind = 'file'");
    if (q.after !== undefined) {
      where.push('m.hlc_t >= ?');
      args.push(q.after);
    }
    if (q.before !== undefined) {
      where.push('m.hlc_t < ?');
      args.push(q.before);
    }
    args.push(q.limit);
    const cols = MSG.replace(/(^|,\s*)(\w+)/g, '$1m.$2');
    return this.db
      .prepare(
        `SELECT ${cols}, ${snippet} AS snippet FROM ${from} WHERE ${where.join(' AND ')} ORDER BY m.hlc_t DESC LIMIT ?`,
      )
      .all(...args) as Array<MessageRow & { snippet: string }>;
  }

  /** Drop everything materialised from the log (`rebuild` replays events afterwards). */
  clearMaterialised(): void {
    this.db.exec(
      'DELETE FROM messages; DELETE FROM reactions; DELETE FROM pins; DELETE FROM receipts; DELETE FROM poll_votes; DELETE FROM poll_close;',
    );
  }

  /** The same for one conversation (its membership changed). */
  clearConversation(convId: string): void {
    for (const t of ['messages', 'reactions', 'pins', 'receipts', 'poll_votes', 'poll_close']) {
      this.db.prepare(`DELETE FROM ${t} WHERE conv_id = ?`).run(convId);
    }
  }

  // ---------------------------------------------------------------------------
  // Threads and polls
  // ---------------------------------------------------------------------------

  /** Channel root posts only, newest `limit` before the cursor, in display order. */
  roots(convId: string, limit: number, before?: { hlc: Hlc; author: string }): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${MSG} FROM messages WHERE conv_id = ? AND thread_author IS NULL
            AND (hlc_t, hlc_c, author) < (?, ?, ?)
          ORDER BY hlc_t DESC, hlc_c DESC, author DESC LIMIT ?`,
      )
      .all(
        convId,
        before?.hlc.t ?? Number.MAX_SAFE_INTEGER,
        before?.hlc.c ?? 0,
        before?.author ?? '',
        limit,
      );
    return (rows as MessageRow[]).reverse();
  }

  thread(convId: string, root: MsgRef): MessageRow[] {
    return this.db
      .prepare(
        `SELECT ${MSG} FROM messages WHERE conv_id = ? AND thread_author = ? AND thread_seq = ?
          ORDER BY hlc_t, hlc_c, author`,
      )
      .all(convId, root.author, root.seq) as MessageRow[];
  }

  replyStats(convId: string, root: MsgRef): { count: number; last: number | null } {
    return this.db
      .prepare(
        `SELECT count(*) AS count, MAX(hlc_t) AS last FROM messages
          WHERE conv_id = ? AND thread_author = ? AND thread_seq = ? AND deleted = 0`,
      )
      .get(convId, root.author, root.seq) as { count: number; last: number | null };
  }

  setVote(convId: string, target: MsgRef, voter: string, choices: number[], at: Hlc): boolean {
    const cur = this.db
      .prepare(
        'SELECT hlc_t AS t, hlc_c AS c FROM poll_votes WHERE conv_id = ? AND target_author = ? AND target_seq = ? AND voter = ?',
      )
      .get(convId, target.author, target.seq, voter) as { t: number; c: number } | undefined;
    if (cur && (cur.t > at.t || (cur.t === at.t && cur.c >= at.c))) return false;
    this.db
      .prepare(
        `INSERT INTO poll_votes (conv_id, target_author, target_seq, voter, choices_json, hlc_t, hlc_c)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET choices_json = excluded.choices_json, hlc_t = excluded.hlc_t, hlc_c = excluded.hlc_c`,
      )
      .run(convId, target.author, target.seq, voter, JSON.stringify(choices), at.t, at.c);
    return true;
  }

  /** The earliest close wins (a poll closes once). */
  closePoll(convId: string, target: MsgRef, at: Hlc): boolean {
    const cur = this.pollClose(convId, target);
    if (cur && (cur.t < at.t || (cur.t === at.t && cur.c <= at.c))) return false;
    this.db
      .prepare(
        `INSERT INTO poll_close (conv_id, target_author, target_seq, hlc_t, hlc_c) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET hlc_t = excluded.hlc_t, hlc_c = excluded.hlc_c`,
      )
      .run(convId, target.author, target.seq, at.t, at.c);
    return true;
  }

  pollClose(convId: string, target: MsgRef): Hlc | undefined {
    return this.db
      .prepare(
        'SELECT hlc_t AS t, hlc_c AS c FROM poll_close WHERE conv_id = ? AND target_author = ? AND target_seq = ?',
      )
      .get(convId, target.author, target.seq) as Hlc | undefined;
  }

  votes(
    convId: string,
    target: MsgRef,
  ): Array<{ voter: string; choices: number[]; t: number; c: number }> {
    return (
      this.db
        .prepare(
          `SELECT voter, choices_json AS choices, hlc_t AS t, hlc_c AS c FROM poll_votes
            WHERE conv_id = ? AND target_author = ? AND target_seq = ?`,
        )
        .all(convId, target.author, target.seq) as Array<{
        voter: string;
        choices: string;
        t: number;
        c: number;
      }>
    ).map((v) => ({ ...v, choices: JSON.parse(v.choices) as number[] }));
  }

  files(convId?: string): MessageRow[] {
    return (
      convId
        ? this.db
            .prepare(
              `SELECT ${MSG} FROM messages WHERE kind = 'file' AND deleted = 0 AND conv_id = ? ORDER BY hlc_t DESC LIMIT 1000`,
            )
            .all(convId)
        : this.db
            .prepare(
              `SELECT ${MSG} FROM messages WHERE kind = 'file' AND deleted = 0 ORDER BY hlc_t DESC LIMIT 1000`,
            )
            .all()
    ) as MessageRow[];
  }

  /** Canonical dump of materialised state, for the rebuild test. */
  dump(): string {
    const q = (sql: string) => JSON.stringify(this.db.prepare(sql).all());
    return [
      q(`SELECT ${MSG} FROM messages ORDER BY conv_id, author, seq`),
      q('SELECT * FROM reactions ORDER BY conv_id, target_author, target_seq, user_id, emoji'),
      q('SELECT * FROM pins ORDER BY conv_id, target_author, target_seq'),
      q('SELECT * FROM receipts ORDER BY conv_id, user_id'),
      q('SELECT * FROM poll_votes ORDER BY conv_id, target_author, target_seq, voter'),
      q('SELECT * FROM poll_close ORDER BY conv_id, target_author, target_seq'),
    ].join('\n');
  }
}

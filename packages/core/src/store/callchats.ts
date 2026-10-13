import type Database from 'better-sqlite3';

export type CallChatState = 'active' | 'kept' | 'discarded';

export interface CallChatRow {
  convId: string;
  callId: string;
  interacted: boolean;
  state: CallChatState;
}

/**
 * The chats made for calls of three or more people. They are ordinary groups; this only says
 * which ones, whether anybody has written in them, and whether they show in the chat list.
 */
export class CallChatRepo {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  get(convId: string): CallChatRow | undefined {
    const r = this.db
      .prepare(
        'SELECT conv_id AS convId, call_id AS callId, interacted, state FROM call_chats WHERE conv_id = ?',
      )
      .get(convId) as
      { convId: string; callId: string; interacted: number; state: CallChatState } | undefined;
    return r && { ...r, interacted: r.interacted === 1 };
  }

  /** Note that this conversation is a call's chat (the first time wins). */
  add(convId: string, callId: string, now: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO call_chats (conv_id, call_id, interacted, state, created_at) VALUES (?, ?, 0, 'active', ?)",
      )
      .run(convId, callId, now);
  }

  byCall(callId: string): CallChatRow[] {
    return (
      this.db
        .prepare(
          'SELECT conv_id AS convId, call_id AS callId, interacted, state FROM call_chats WHERE call_id = ?',
        )
        .all(callId) as Array<{
        convId: string;
        callId: string;
        interacted: number;
        state: CallChatState;
      }>
    ).map((r) => ({ ...r, interacted: r.interacted === 1 }));
  }

  markInteracted(convId: string): void {
    this.db.prepare('UPDATE call_chats SET interacted = 1 WHERE conv_id = ?').run(convId);
  }

  setState(convId: string, state: CallChatState): void {
    this.db.prepare('UPDATE call_chats SET state = ? WHERE conv_id = ?').run(state, convId);
  }

  /** Not in the chat list: its call is still going, or nobody wrote in it. */
  isHidden(convId: string): boolean {
    const r = this.db.prepare('SELECT state FROM call_chats WHERE conv_id = ?').get(convId) as
      { state: CallChatState } | undefined;
    return r !== undefined && r.state !== 'kept';
  }
}

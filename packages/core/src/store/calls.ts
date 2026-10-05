import type Database from 'better-sqlite3';
import type { CallHistoryItem } from '@officemesh/protocol/ipc';

type Outcome = NonNullable<CallHistoryItem['outcome']>;

interface Row {
  callId: string;
  convId: string | null;
  direction: 'in' | 'out';
  media: 'audio' | 'video';
  peersJson: string;
  startedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  outcome: Outcome | null;
}

const COLUMNS = `call_id AS callId, conv_id AS convId, direction, media, peers_json AS peersJson,
  started_at AS startedAt, answered_at AS answeredAt, ended_at AS endedAt, outcome`;

/** Local call history: one row per call this PC placed, joined or was invited to. */
export class CallRepo {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  begin(c: {
    callId: string;
    convId?: string | undefined;
    direction: 'in' | 'out';
    media: 'audio' | 'video';
    peers: string[];
    startedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO calls (call_id, conv_id, direction, media, peers_json, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(c.callId, c.convId ?? null, c.direction, c.media, JSON.stringify(c.peers), c.startedAt);
  }

  setPeers(callId: string, peers: string[]): void {
    this.db
      .prepare('UPDATE calls SET peers_json = ? WHERE call_id = ?')
      .run(JSON.stringify(peers), callId);
  }

  answered(callId: string, at: number): void {
    this.db
      .prepare('UPDATE calls SET answered_at = coalesce(answered_at, ?) WHERE call_id = ?')
      .run(at, callId);
  }

  end(callId: string, at: number, outcome: Outcome): void {
    this.db
      .prepare('UPDATE calls SET ended_at = ?, outcome = ? WHERE call_id = ? AND ended_at IS NULL')
      .run(at, outcome, callId);
  }

  list(limit = 200): CallHistoryItem[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM calls ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map((r) => ({
      callId: r.callId,
      ...(r.convId && { convId: r.convId }),
      direction: r.direction,
      media: r.media,
      peers: JSON.parse(r.peersJson) as string[],
      startedAt: r.startedAt,
      ...(r.answeredAt !== null && { answeredAt: r.answeredAt }),
      ...(r.endedAt !== null && { endedAt: r.endedAt }),
      ...(r.outcome && { outcome: r.outcome }),
    }));
  }

  /** Calls still open after a restart can no longer be in progress. */
  closeDangling(at: number): void {
    this.db
      .prepare(
        `UPDATE calls SET ended_at = ?, outcome = CASE
           WHEN answered_at IS NOT NULL THEN 'completed'
           WHEN direction = 'in' THEN 'missed' ELSE 'cancelled' END
         WHERE ended_at IS NULL`,
      )
      .run(at);
  }
}

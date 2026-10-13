import type Database from 'better-sqlite3';
import type { PeerTrust } from '@officemesh/protocol/ipc';

export interface PeerRow {
  userId: string;
  publicKey: Buffer;
  profileJson: string | null;
  displayName: string | null;
  firstSeen: number;
  lastSeen: number;
  lastAddress: string | null;
  lastPort: number | null;
  trust: PeerTrust;
  verified: number;
  /** 1: removed from the list by the user. */
  hidden?: number;
}

const COLUMNS = `user_id AS userId, public_key AS publicKey, profile_json AS profileJson,
  display_name AS displayName, first_seen AS firstSeen, last_seen AS lastSeen,
  last_address AS lastAddress, last_port AS lastPort, trust, verified, hidden`;

/** Known peers. Rows are written on first sight and on change, never per beacon. */
export class PeerRepo {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  all(): PeerRow[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM peers`).all() as PeerRow[];
  }

  get(userId: string): PeerRow | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM peers WHERE user_id = ?`).get(userId) as
      PeerRow | undefined;
  }

  insert(row: PeerRow): void {
    this.db
      .prepare(
        `INSERT INTO peers (user_id, public_key, profile_json, display_name, first_seen, last_seen,
                            last_address, last_port, trust, verified)
         VALUES (@userId, @publicKey, @profileJson, @displayName, @firstSeen, @lastSeen,
                 @lastAddress, @lastPort, @trust, @verified)`,
      )
      .run(row);
  }

  setSeen(userId: string, lastSeen: number, address: string | null, port: number | null): void {
    this.db
      .prepare('UPDATE peers SET last_seen = ?, last_address = ?, last_port = ? WHERE user_id = ?')
      .run(lastSeen, address, port, userId);
  }

  setProfile(userId: string, profileJson: string, displayName: string): void {
    this.db
      .prepare('UPDATE peers SET profile_json = ?, display_name = ? WHERE user_id = ?')
      .run(profileJson, displayName, userId);
  }

  setTrust(userId: string, trust: PeerTrust): void {
    this.db.prepare('UPDATE peers SET trust = ? WHERE user_id = ?').run(trust, userId);
  }

  setHidden(userId: string, hidden: boolean): void {
    this.db.prepare('UPDATE peers SET hidden = ? WHERE user_id = ?').run(hidden ? 1 : 0, userId);
  }

  setVerified(userId: string, verified: boolean): void {
    this.db
      .prepare('UPDATE peers SET verified = ? WHERE user_id = ?')
      .run(verified ? 1 : 0, userId);
  }

  /** Other peers already known under this display name (case-insensitive). */
  othersWithName(displayName: string, exceptUserId: string): PeerRow[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM peers WHERE display_name = ? COLLATE NOCASE AND user_id <> ?`,
      )
      .all(displayName, exceptUserId) as PeerRow[];
  }
}

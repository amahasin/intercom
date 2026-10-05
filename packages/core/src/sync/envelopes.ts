import type { KeyObject } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { z } from 'zod';
import {
  decodeBase64Url,
  encodeBase64Url,
  ENVELOPE_CARRIERS,
  ENVELOPE_STORE_BYTES,
  ENVELOPE_TTL_MS,
  EnvelopeAckBody,
  EnvelopeContent,
  EnvelopeStoreBody,
  MAX_ENVELOPE_CT,
  MAX_ENVELOPES_PER_FRAME,
  SealedEnvelope,
} from '@officemesh/protocol';
import { openSealed, sealFor, sha256, userIdFromSpki } from '../identity/crypto.ts';
import type { Clock, Logger } from '../interfaces.ts';
import type { LinkManager } from '../link/link-manager.ts';
import { directConvId } from './direct.ts';

/** Envelopes one depositor may leave with this PC, so nobody fills it alone. */
const PER_DEPOSITOR_BYTES = 10 * 1024 * 1024;
/** Frames sent to one peer per tick (the link allows 50 a second). */
const FRAMES_PER_TICK = 20;
/** Bytes of envelopes in one frame (the frame limit is 256 KB). */
const FRAME_BYTES = 200 * 1024;
const RETRY_MS = 30_000;
const INFLIGHT_MS = 15_000;
const FETCH_AGAIN_MS = 10 * 60_000;

export interface EnvelopeServiceOptions {
  db: Database.Database;
  selfId: string;
  privateKey: KeyObject;
  spki: Buffer;
  links: LinkManager;
  clock: Clock;
  logger: Logger;
  keyFor(userId: string): KeyObject | undefined;
  /** Colleagues online now (candidate carriers). */
  onlinePeers(): string[];
  connect(userId: string): Promise<boolean>;
  /** A sealed event for us, opened and checked: apply it as if its author had sent it. */
  deliver(author: string, spki: Buffer, event: Record<string, unknown>): boolean;
  /** Own messages that now have (or no longer need) carriers. */
  carriersChanged(convId: string, seqs: number[]): void;
}

interface OutRow {
  id: string;
  convId: string;
  seq: number;
  to: string;
  json: string;
  carriers: string[];
}

export interface EnvelopeStats {
  /** Other people's envelopes held here. */
  carrying: number;
  carryingBytes: number;
  /** Own envelopes waiting for their recipient. */
  outgoing: number;
}

function envelopeId(env: SealedEnvelope): string {
  return sha256(`${env.to}\0${env.exp}\0${env.epk}\0${env.iv}\0${env.ct}`).toString('hex');
}

function aadOf(env: Pick<SealedEnvelope, 'v' | 'to' | 'exp'>): string {
  return `${env.v}\0${env.to}\0${env.exp}`;
}

/**
 * Offline delivery for direct chats (plan section 8, M6). An own event for a recipient who
 * is offline is sealed to their key (ECDH + AES-256-GCM) and left with up to 3 online
 * colleagues. A carrier stores at most 50 MB of other people's envelopes for 7 days and
 * hands them over when it sees the recipient; it can read neither the content nor who
 * wrote it.
 */
export class EnvelopeService {
  private readonly o: EnvelopeServiceOptions;
  /** Envelope id to carriers asked and when, until they acknowledge. */
  private readonly inflight = new Map<string, Map<string, number>>();
  /** Peers that cannot carry (no `envelopes.v1`). */
  private readonly incapable = new Set<string>();
  /** Recipients with more held envelopes than one tick could send. */
  private readonly backlog = new Set<string>();
  private readonly fetchedAt = new Map<string, number>();
  private lastRetry = 0;

  constructor(options: EnvelopeServiceOptions) {
    this.o = options;
    const { links } = options;
    links.on('envelope.store', (from, body) => this.onStore(from, EnvelopeStoreBody.parse(body)));
    links.on('envelope.fetch', (from) => {
      this.sendHeld(from);
    });
    links.on('envelope.ack', (from, body) => this.onAck(from, EnvelopeAckBody.parse(body).ids));
    links.onLinkUp((userId) => this.onLinkUp(userId));
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /** Seal an own direct-chat event for a recipient who could not be reached, and place it. */
  seal(convId: string, seq: number, to: string, event: Record<string, unknown>): void {
    const key = this.o.keyFor(to);
    if (!key) return;
    const now = this.o.clock.now();
    const head = { v: 1 as const, to, exp: now + ENVELOPE_TTL_MS };
    const plain = Buffer.from(
      JSON.stringify({ event, pub: encodeBase64Url(this.o.spki) } satisfies z.infer<
        typeof EnvelopeContent
      >),
    );
    const sealed = sealFor(key, plain, aadOf(head));
    const env: SealedEnvelope = {
      ...head,
      epk: encodeBase64Url(sealed.epk),
      iv: encodeBase64Url(sealed.iv),
      ct: encodeBase64Url(sealed.ct),
    };
    if (env.ct.length > MAX_ENVELOPE_CT) {
      this.o.logger.warn('event too large to seal', { convId, seq });
      return;
    }
    const id = envelopeId(env);
    this.o.db
      .prepare(
        `INSERT OR IGNORE INTO envelopes_out (id, conv_id, seq, to_user, json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, convId, seq, to, JSON.stringify(env), now, env.exp);
    this.place();
  }

  /** The recipient now holds everything up to `upto`: their envelopes are no longer needed. */
  acked(convId: string, upto: number): void {
    const gone = this.o.db
      .prepare('DELETE FROM envelopes_out WHERE conv_id = ? AND seq <= ? RETURNING seq')
      .all(convId, upto) as Array<{ seq: number }>;
    if (gone.length > 0)
      this.o.carriersChanged(
        convId,
        gone.map((r) => r.seq),
      );
  }

  /** Whether an own message is sealed and left with at least one carrier. */
  carried(convId: string, seq: number): boolean {
    const row = this.o.db
      .prepare(`SELECT carriers_json AS c FROM envelopes_out WHERE conv_id = ? AND seq = ?`)
      .get(convId, seq) as { c: string } | undefined;
    return row !== undefined && row.c !== '[]';
  }

  private outgoing(): OutRow[] {
    const now = this.o.clock.now();
    return (
      this.o.db
        .prepare(
          `SELECT id, conv_id AS convId, seq, to_user AS "to", json, carriers_json AS carriers
             FROM envelopes_out WHERE expires_at > ? ORDER BY created_at`,
        )
        .all(now) as Array<Omit<OutRow, 'carriers'> & { carriers: string }>
    ).map((r) => ({ ...r, carriers: JSON.parse(r.carriers) as string[] }));
  }

  /** Hand envelopes that have fewer than 3 carriers to online colleagues who can carry. */
  place(): void {
    const now = this.o.clock.now();
    const rows = this.outgoing().filter((r) => r.carriers.length < ENVELOPE_CARRIERS);
    if (rows.length === 0) return;
    const online = this.o
      .onlinePeers()
      .filter((p) => p !== this.o.selfId && !this.incapable.has(p));
    // Peers with a link already go first: no dialing needed.
    online.sort((a, b) => Number(this.o.links.isReady(b)) - Number(this.o.links.isReady(a)));
    const plan = new Map<string, OutRow[]>();
    for (const row of rows) {
      const asked = this.inflight.get(row.id) ?? new Map<string, number>();
      for (const [peer, at] of asked) if (now - at > INFLIGHT_MS) asked.delete(peer);
      let need = ENVELOPE_CARRIERS - row.carriers.length - asked.size;
      for (const peer of online) {
        if (need <= 0) break;
        if (peer === row.to || row.carriers.includes(peer) || asked.has(peer)) continue;
        asked.set(peer, now);
        need--;
        let list = plan.get(peer);
        if (!list) plan.set(peer, (list = []));
        list.push(row);
      }
      this.inflight.set(row.id, asked);
    }
    for (const [peer, list] of plan) {
      void this.o.connect(peer).then((ok) => {
        if (!ok) return;
        if (!this.o.links.hasCap(peer, 'envelopes.v1')) {
          this.incapable.add(peer);
          for (const r of list) this.inflight.get(r.id)?.delete(peer);
          return;
        }
        this.sendFrames(
          peer,
          list.map((r) => JSON.parse(r.json) as SealedEnvelope),
        );
      });
    }
  }

  // -------------------------------------------------------------------------
  // Carrying and receiving
  // -------------------------------------------------------------------------

  private onStore(from: string, body: { envelopes: SealedEnvelope[] }): void {
    const now = this.o.clock.now();
    const ids: string[] = [];
    for (const env of body.envelopes) {
      const id = envelopeId(env);
      if (env.exp <= now) continue;
      if (env.to === this.o.selfId) {
        if (this.open(env)) ids.push(id);
        continue;
      }
      // Never carry for the depositor itself; never past 7 days from now.
      if (env.to === from) continue;
      if (this.hold(id, env, from, Math.min(env.exp, now + ENVELOPE_TTL_MS))) ids.push(id);
    }
    if (ids.length > 0) this.o.links.send(from, 'envelope.ack', { ids });
  }

  /** Open an envelope addressed to us and apply the event inside. */
  private open(env: SealedEnvelope): boolean {
    let content: { event: Record<string, unknown>; pub: string };
    try {
      const plain = openSealed(
        this.o.privateKey,
        {
          epk: Buffer.from(decodeBase64Url(env.epk)),
          iv: Buffer.from(decodeBase64Url(env.iv)),
          ct: Buffer.from(decodeBase64Url(env.ct)),
        },
        aadOf(env),
      );
      content = EnvelopeContent.parse(JSON.parse(plain.toString('utf8')));
    } catch (err) {
      this.o.logger.warn('envelope could not be opened', { err: String(err) });
      // Ours but unreadable (tampered or corrupt): acknowledge so the carrier drops it.
      return true;
    }
    const spki = Buffer.from(decodeBase64Url(content.pub));
    const author = content.event['author'];
    if (
      typeof author !== 'string' ||
      userIdFromSpki(spki) !== author ||
      content.event['convId'] !== directConvId(this.o.selfId, author)
    ) {
      this.o.logger.warn('envelope content does not match its author');
      return true;
    }
    this.o.deliver(author, spki, content.event);
    return true;
  }

  private hold(id: string, env: SealedEnvelope, from: string, expiresAt: number): boolean {
    const { db } = this.o;
    if (db.prepare('SELECT 1 FROM envelopes WHERE id = ?').get(id)) return true;
    const json = JSON.stringify(env);
    const bytes = Buffer.byteLength(json);
    const total = (
      db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM envelopes').get() as {
        n: number;
      }
    ).n;
    const mine = (
      db
        .prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM envelopes WHERE from_user = ?')
        .get(from) as { n: number }
    ).n;
    if (total + bytes > ENVELOPE_STORE_BYTES || mine + bytes > PER_DEPOSITOR_BYTES) {
      this.o.logger.warn('envelope store full; refusing an envelope', { from });
      return false;
    }
    db.prepare(
      `INSERT INTO envelopes (id, to_user, from_user, json, bytes, received_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, env.to, from, json, bytes, this.o.clock.now(), expiresAt);
    // The recipient may be online already (the sender could not reach it, we can).
    this.offer(env.to);
    return true;
  }

  private onAck(from: string, ids: string[]): void {
    const { db } = this.o;
    // From a recipient: it opened envelopes we carried for it.
    const del = db.prepare('DELETE FROM envelopes WHERE id = ? AND to_user = ?');
    for (const id of ids) del.run(id, from);
    // From a carrier: it now holds envelopes we sealed.
    const changed = new Map<string, number[]>();
    for (const id of ids) {
      const row = db
        .prepare(
          `SELECT conv_id AS convId, seq, to_user AS "to", carriers_json AS carriers
             FROM envelopes_out WHERE id = ?`,
        )
        .get(id) as { convId: string; seq: number; to: string; carriers: string } | undefined;
      this.inflight.get(id)?.delete(from);
      if (!row || row.to === from) continue;
      const carriers = JSON.parse(row.carriers) as string[];
      if (carriers.includes(from)) continue;
      carriers.push(from);
      db.prepare('UPDATE envelopes_out SET carriers_json = ? WHERE id = ?').run(
        JSON.stringify(carriers),
        id,
      );
      let list = changed.get(row.convId);
      if (!list) changed.set(row.convId, (list = []));
      list.push(row.seq);
    }
    for (const [convId, seqs] of changed) this.o.carriersChanged(convId, seqs);
  }

  private heldFor(userId: string): SealedEnvelope[] {
    return (
      this.o.db
        .prepare(
          'SELECT json FROM envelopes WHERE to_user = ? AND expires_at > ? ORDER BY received_at',
        )
        .all(userId, this.o.clock.now()) as Array<{ json: string }>
    ).map((r) => SealedEnvelope.parse(JSON.parse(r.json)));
  }

  /** A recipient came online (beacon) or linked: hand over what we carry for it. */
  offer(userId: string): void {
    if (userId === this.o.selfId || this.heldFor(userId).length === 0) return;
    if (this.o.links.isReady(userId)) {
      this.sendHeld(userId);
      return;
    }
    void this.o.connect(userId).then((ok) => ok && this.sendHeld(userId));
  }

  private sendHeld(userId: string): void {
    if (!this.o.links.hasCap(userId, 'envelopes.v1')) return;
    const held = this.heldFor(userId);
    if (held.length === 0) return;
    if (!this.sendFrames(userId, held)) this.backlog.add(userId);
    else this.backlog.delete(userId);
  }

  /**
   * Send envelopes in frames of up to 16 (and 200 KB), at most 20 frames now. Returns
   * false if some are left for the next tick.
   */
  private sendFrames(peer: string, envelopes: SealedEnvelope[]): boolean {
    let frames = 0;
    let batch: SealedEnvelope[] = [];
    let bytes = 0;
    const flush = () => {
      if (batch.length > 0) this.o.links.send(peer, 'envelope.store', { envelopes: batch });
      frames++;
      batch = [];
      bytes = 0;
    };
    for (const env of envelopes) {
      const size = env.ct.length + 300;
      if (batch.length >= MAX_ENVELOPES_PER_FRAME || bytes + size > FRAME_BYTES) {
        flush();
        if (frames >= FRAMES_PER_TICK) return false;
      }
      batch.push(env);
      bytes += size;
    }
    flush();
    return true;
  }

  private onLinkUp(userId: string): void {
    // Hand over what we carry for them, and ask what they carry for us (they may carry
    // for us from another subnet, where they never see our beacon).
    this.offer(userId);
    const now = this.o.clock.now();
    if (now - (this.fetchedAt.get(userId) ?? -Infinity) < FETCH_AGAIN_MS) return;
    this.fetchedAt.set(userId, now);
    this.o.links.send(userId, 'envelope.fetch', {});
  }

  /** Called every second: drain backlogs, retry placement, drop expired envelopes. */
  tick(): void {
    for (const userId of [...this.backlog]) {
      if (this.o.links.isReady(userId)) this.sendHeld(userId);
      else this.backlog.delete(userId);
    }
    const now = this.o.clock.now();
    if (now - this.lastRetry < RETRY_MS) return;
    this.lastRetry = now;
    this.o.db.prepare('DELETE FROM envelopes WHERE expires_at <= ?').run(now);
    this.o.db.prepare('DELETE FROM envelopes_out WHERE expires_at <= ?').run(now);
    this.place();
  }

  stats(): EnvelopeStats {
    const held = this.o.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM envelopes')
      .get() as { n: number; b: number };
    const out = this.o.db.prepare('SELECT COUNT(*) AS n FROM envelopes_out').get() as { n: number };
    return { carrying: held.n, carryingBytes: held.b, outgoing: out.n };
  }
}

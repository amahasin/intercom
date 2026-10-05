import type { KeyObject } from 'node:crypto';
import {
  EVENT_BODIES,
  LINK_LIMITS,
  LogEvent,
  MAX_TEXT_FRAME_BYTES,
  SYNC_BATCH_EVENTS,
  TARGETED_EVENT_TYPES,
  EventAckBody,
  SyncEventsBody,
  SyncSummaryBody,
  EventPushBody,
  TypingBody,
  type EventType,
  type MsgRef,
} from '@officemesh/protocol';
import type { DeliveryStatus } from '@officemesh/protocol/ipc';
import { signRecord, verifyRecord } from '../identity/crypto.ts';
import type { Clock, Logger } from '../interfaces.ts';
import type { LinkManager } from '../link/link-manager.ts';
import type { ConversationRepo, ConversationRow } from '../store/conversations.ts';
import type { MessageRepo } from '../store/messages.ts';
import { emptyEffects, type Effects, Materializer } from './materialize.ts';
import { directConvId } from './direct.ts';
import type { HybridClock } from './hlc.ts';

/** Leave headroom under the frame limit for the envelope around a batch. */
const BATCH_BYTES = MAX_TEXT_FRAME_BYTES - 16 * 1024;
/** Cap on events held while waiting for a gap to fill, per conversation and author. */
const MAX_BUFFERED = 5_000;

export interface SyncEvents {
  /** Materialised changes from local or received events. */
  effects(fx: Effects, local: boolean): void;
  /** Own messages whose delivery status changed (acks). */
  statusChanged(convId: string, refs: MsgRef[]): void;
  conversationsChanged(convIds: string[]): void;
  typing(convId: string, userId: string): void;
}

export interface SyncEngineOptions {
  repo: ConversationRepo;
  messages: MessageRepo;
  selfId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  hlc: HybridClock;
  clock: Clock;
  logger: Logger;
  links: LinkManager;
  /** The pinned key of a known peer. */
  keyFor(userId: string): KeyObject | undefined;
  isOnline(userId: string): boolean;
  /** Ask for a link to a peer that has something waiting (dials if it is reachable). */
  wantLink(userId: string): void;
  events: SyncEvents;
}

type Outcome = 'applied' | 'duplicate' | 'buffered' | 'rejected';

/**
 * The conversation log: writes signed events, applies events from peers exactly once and
 * in order, and swaps whatever the other side is missing whenever a link opens.
 */
export class SyncEngine {
  private readonly o: SyncEngineOptions;
  /** Events that arrived ahead of a gap, keyed by `convId:author`. */
  private readonly buffered = new Map<string, Map<number, unknown>>();
  /** Peers this PC holds unacknowledged own events for. */
  private readonly pending = new Set<string>();
  readonly materializer: Materializer;

  constructor(options: SyncEngineOptions) {
    this.o = options;
    this.materializer = new Materializer(options.selfId, options.messages, options.repo);
    const { links } = options;
    links.on('typing', (from, body) => {
      const { convId } = TypingBody.parse(body);
      if (options.repo.isMember(convId, from)) options.events.typing(convId, from);
    });
    links.onLinkUp((userId) => this.sendSummary(userId));
    links.on('sync.summary', (from, body) => this.onSummary(from, SyncSummaryBody.parse(body)));
    links.on('sync.events', (from, body) => this.onEvents(from, SyncEventsBody.parse(body)));
    links.on('event.push', (from, body) => {
      const touched = new Map<string, number>();
      this.applyFrom(from, EventPushBody.parse(body).event, touched);
      this.sendAcks(from, touched);
    });
    links.on('event.ack', (from, body) => this.onAck(from, EventAckBody.parse(body)));
  }

  /** Recompute which peers are waiting for own events (on start-up). */
  loadPending(peers: Iterable<string>): void {
    for (const p of peers) if (this.o.repo.hasUnacked(p, this.o.selfId)) this.pending.add(p);
  }

  hasPendingFor(userId: string): boolean {
    return this.pending.has(userId);
  }

  directConvId(peer: string): string {
    return directConvId(this.o.selfId, peer);
  }

  openDirect(peer: string): ConversationRow {
    if (peer === this.o.selfId) throw new Error('cannot open a chat with yourself');
    const convId = this.directConvId(peer);
    const existing = this.o.repo.get(convId);
    if (existing) return existing;
    const row = this.o.repo.createDirect(convId, this.o.selfId, peer, this.o.clock.now());
    this.o.events.conversationsChanged([convId]);
    return row;
  }

  /** Sign, store and materialise an own event, then send it to every reachable member. */
  append(
    convId: string,
    type: EventType,
    body: Record<string, unknown>,
  ): { author: string; seq: number } {
    const { repo, selfId } = this.o;
    if (!repo.get(convId)) throw new Error('unknown conversation');
    const schema = (EVENT_BODIES as Record<string, { parse(v: unknown): unknown }>)[type];
    const parsed = (schema ? schema.parse(body) : body) as Record<string, unknown>;
    const unsigned = {
      convId,
      author: selfId,
      seq: repo.head(convId, selfId) + 1,
      hlc: this.o.hlc.now(),
      type,
      body: parsed,
    };
    const event = signRecord(this.o.privateKey, unsigned);
    const fx = emptyEffects();
    repo.transaction(() => {
      repo.insertEvent(
        { ...event, json: JSON.stringify(event), target: targetOf(type, parsed) },
        this.o.clock.now(),
      );
      this.materializer.apply(event, true, fx);
      repo.touch(convId, event.hlc.t);
    });
    this.o.events.effects(fx, true);
    this.o.events.conversationsChanged([convId]);

    for (const member of repo.members(convId)) {
      if (member === selfId) continue;
      this.pending.add(member);
      if (!this.o.links.send(member, 'event.push', { event })) this.o.wantLink(member);
    }
    return { author: selfId, seq: event.seq };
  }

  /** Delivery status of an own message, as the sender sees it. */
  status(convId: string, seq: number, hlc: { t: number; c: number }): DeliveryStatus {
    const others = this.o.repo.members(convId).filter((m) => m !== this.o.selfId);
    const seen = others.every((m) => {
      const r = this.o.messages.receipt(convId, m);
      return r !== undefined && (r.t > hlc.t || (r.t === hlc.t && r.c >= hlc.c));
    });
    if (seen && others.length > 0) return 'read';
    if (others.every((m) => this.o.repo.getAck(convId, m, this.o.selfId) >= seq))
      return 'delivered';
    return others.some((m) => this.o.isOnline(m)) ? 'sending' : 'waiting';
  }

  /** Tell members with an open link that this user is typing (never dials for it). */
  sendTyping(convId: string): void {
    for (const member of this.o.repo.members(convId)) {
      if (member !== this.o.selfId) this.o.links.send(member, 'typing', { convId });
    }
  }

  /** Re-derive messages, reactions, pins and receipts from the event log. */
  rebuild(): void {
    const { repo } = this.o;
    repo.transaction(() => {
      this.o.messages.clearMaterialised();
      const fx = emptyEffects();
      for (const json of repo.allEvents()) {
        const parsed = LogEvent.safeParse(JSON.parse(json));
        if (parsed.success) this.materializer.apply(parsed.data, false, fx);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Anti-entropy
  // -------------------------------------------------------------------------

  private sendSummary(userId: string): void {
    const convs = this.o.repo
      .sharedWith(userId)
      .map((convId) => ({ convId, heads: this.o.repo.heads(convId) }));
    this.o.links.send(userId, 'sync.summary', { convs });
  }

  private onSummary(from: string, summary: SyncSummaryBody): void {
    const { repo } = this.o;
    const theirs = new Map(summary.convs.map((c) => [c.convId, c.heads]));
    // What they hold tells us what they have received: raise acks.
    for (const [convId, heads] of theirs) {
      if (!repo.isMember(convId, from)) continue;
      for (const [author, seq] of Object.entries(heads)) this.raiseAck(convId, from, author, seq);
    }
    // Send what they lack, up to the per-reply limit.
    let budget: number = LINK_LIMITS.eventsPerSyncReply;
    let batch: unknown[] = [];
    let bytes = 0;
    const flush = (more: boolean) => {
      if (batch.length === 0 && !more) return;
      this.o.links.send(from, 'sync.events', { events: batch, ...(more && { more: true }) });
      batch = [];
      bytes = 0;
    };
    outer: for (const convId of repo.sharedWith(from)) {
      const their = theirs.get(convId) ?? {};
      for (const [author, mine] of Object.entries(repo.heads(convId))) {
        let after = their[author] ?? 0;
        while (after < mine) {
          if (budget <= 0) {
            flush(true);
            break outer;
          }
          const rows = repo.eventsAfter(convId, author, after, Math.min(SYNC_BATCH_EVENTS, budget));
          if (rows.length === 0) break;
          for (const json of rows) {
            const size = Buffer.byteLength(json);
            if (batch.length >= SYNC_BATCH_EVENTS || bytes + size > BATCH_BYTES) flush(false);
            batch.push(JSON.parse(json));
            bytes += size;
            budget--;
            after++;
          }
        }
      }
    }
    flush(false);
  }

  private onEvents(from: string, body: { events: unknown[]; more?: boolean | undefined }): void {
    const touched = new Map<string, number>();
    for (const raw of body.events) this.applyFrom(from, raw, touched);
    this.sendAcks(from, touched);
    if (body.more) this.sendSummary(from);
  }

  private onAck(from: string, ack: EventAckBody): void {
    if (this.o.repo.isMember(ack.convId, from))
      this.raiseAck(ack.convId, from, ack.author, ack.upto);
  }

  private raiseAck(convId: string, member: string, author: string, upto: number): void {
    const { repo, selfId } = this.o;
    const prev = repo.raiseAck(convId, member, author, upto);
    if (prev === undefined || author !== selfId) return;
    if (!repo.hasUnacked(member, selfId)) this.pending.delete(member);
    const refs: MsgRef[] = [];
    for (let seq = prev + 1; seq <= upto; seq++) refs.push({ author: selfId, seq });
    if (refs.length > 0) this.o.events.statusChanged(convId, refs);
  }

  private sendAcks(to: string, touched: Map<string, number>): void {
    for (const [key, upto] of touched) {
      const [convId, author] = key.split(':') as [string, string];
      this.o.links.send(to, 'event.ack', { convId, author, upto });
    }
  }

  // -------------------------------------------------------------------------
  // Applying remote events
  // -------------------------------------------------------------------------

  /** Validate and apply one event received from `from`; records the new head in `touched`. */
  private applyFrom(from: string, raw: unknown, touched: Map<string, number>): Outcome {
    const parsed = LogEvent.safeParse(raw);
    if (!parsed.success) return this.reject(from, 'malformed event');
    const ev = parsed.data;
    const { repo, selfId } = this.o;

    let conv = repo.get(ev.convId);
    if (!conv) {
      // A first message in a 1:1 chat creates the conversation on the receiving side.
      const authorOk = ev.author === from || ev.author === selfId;
      if (ev.convId !== this.directConvId(from) || !authorOk)
        return this.reject(from, 'unknown conversation');
      conv = repo.createDirect(ev.convId, selfId, from, this.o.clock.now());
      this.o.events.conversationsChanged([ev.convId]);
    }
    if (!repo.isMember(conv.convId, ev.author)) return this.reject(from, 'author is not a member');
    // Events of a conversation are only accepted from its members.
    if (!repo.isMember(conv.convId, from)) return this.reject(from, 'sender is not a member');

    const key = ev.author === selfId ? this.o.publicKey : this.o.keyFor(ev.author);
    if (!key) return this.reject(from, 'unknown author key');
    if (!verifyRecord(key, raw)) return this.reject(from, 'bad signature');

    const bufKey = `${ev.convId}:${ev.author}`;
    const head = repo.head(ev.convId, ev.author);
    if (ev.seq <= head) {
      touched.set(bufKey, head);
      return 'duplicate';
    }
    if (ev.seq > head + 1) {
      let buf = this.buffered.get(bufKey);
      if (!buf) this.buffered.set(bufKey, (buf = new Map()));
      if (buf.size < MAX_BUFFERED) buf.set(ev.seq, raw);
      return 'buffered';
    }

    const fx = emptyEffects();
    let next: { ev: LogEvent; raw: unknown } | undefined = { ev, raw };
    let newHead = head;
    repo.transaction(() => {
      while (next) {
        this.store(next.ev, next.raw, fx);
        newHead = next.ev.seq;
        const buf = this.buffered.get(bufKey);
        const followRaw = buf?.get(newHead + 1);
        buf?.delete(newHead + 1);
        if (buf && buf.size === 0) this.buffered.delete(bufKey);
        const follow = followRaw === undefined ? undefined : LogEvent.safeParse(followRaw);
        next =
          follow?.success && verifyRecord(key, followRaw)
            ? { ev: follow.data, raw: followRaw }
            : undefined;
      }
    });
    touched.set(bufKey, newHead);
    this.o.events.effects(fx, false);
    this.o.events.conversationsChanged([ev.convId]);
    return 'applied';
  }

  /** Persist a verified, in-order event and materialise it. */
  private store(ev: LogEvent, raw: unknown, fx: Effects): void {
    const { repo } = this.o;
    const schema = (
      EVENT_BODIES as Record<string, { safeParse(v: unknown): { success: boolean } }>
    )[ev.type];
    // A known type with an invalid body is kept (the author's seq must not gap) but not shown.
    const valid = !schema || schema.safeParse(ev.body).success;
    const target = valid ? targetOf(ev.type, ev.body as Record<string, unknown>) : undefined;
    repo.insertEvent({ ...ev, json: JSON.stringify(raw), target }, this.o.clock.now());
    this.o.hlc.observe(ev.hlc);
    repo.touch(ev.convId, ev.hlc.t);
    if (valid) this.materializer.apply(ev, true, fx);
  }

  private reject(from: string, reason: string): Outcome {
    this.o.logger.warn('rejected event', { from, reason });
    return 'rejected';
  }
}

function targetOf(
  type: string,
  body: Record<string, unknown>,
): { author: string; seq: number } | undefined {
  if (!TARGETED_EVENT_TYPES.has(type)) return undefined;
  const t = body['target'] as { author?: unknown; seq?: unknown } | undefined;
  return typeof t?.author === 'string' && typeof t.seq === 'number'
    ? { author: t.author, seq: t.seq }
    : undefined;
}

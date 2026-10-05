import type { KeyObject } from 'node:crypto';
import {
  decodeBase64Url,
  EVENT_BODIES,
  LINK_LIMITS,
  LogEvent,
  MAX_SYNC_SUMMARY_CONVERSATIONS,
  MAX_TEXT_FRAME_BYTES,
  MEMBERSHIP_EVENT_TYPES,
  SYNC_BATCH_EVENTS,
  TARGETED_EVENT_TYPES,
  EventAckBody,
  SyncEventsBody,
  SyncSummaryBody,
  EventBatchBody,
  EventPushBody,
  TeamDataBody,
  TeamFetchBody,
  TypingBody,
  type EventType,
  type Member,
  type MsgRef,
} from '@officemesh/protocol';
import type { DeliveryStatus } from '@officemesh/protocol/ipc';
import {
  importPublicKeySpki,
  signRecord,
  userIdFromSpki,
  verifyRecord,
} from '../identity/crypto.ts';
import type { Clock, Logger } from '../interfaces.ts';
import type { LinkManager } from '../link/link-manager.ts';
import type { ConversationRepo, ConversationRow } from '../store/conversations.ts';
import type { MessageRepo } from '../store/messages.ts';
import { emptyEffects, type Effects, Materializer } from './materialize.ts';
import { directConvId } from './direct.ts';
import type { HybridClock } from './hlc.ts';
import { genesisConvId } from './ids.ts';
import type { Role } from './membership.ts';
import { Memberships } from './memberships.ts';

/** Leave headroom under the frame limit for the envelope around a batch. */
const BATCH_BYTES = MAX_TEXT_FRAME_BYTES - 16 * 1024;
/** Cap on events held while waiting for a gap to fill, per conversation and author. */
const MAX_BUFFERED = 5_000;
/** Cap on events held for conversations or authors not known yet. */
const MAX_HELD_PER_CONV = 20_000;
const MAX_HELD_CONVS = 200;
const RESYNC_MS = 10_000;
const GOSSIP_MS = 15_000;
const ASK_INTERVAL_MS = 5_000;

export interface SyncEvents {
  /** Materialised changes from local or received events. */
  effects(fx: Effects, local: boolean): void;
  /** Own messages whose delivery status changed (acks). */
  statusChanged(convId: string, refs: MsgRef[]): void;
  conversationsChanged(convIds: string[]): void;
  typing(convId: string, userId: string): void;
  /** Membership or team structure changed; these conversations were re-materialised. */
  membershipChanged(convIds: string[]): void;
  /** A member's key learnt from a member list (trust on first use, like a beacon). */
  learnKey(userId: string, spki: Buffer): void;
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
  /** Sealed envelopes for direct chats (M6): absent in tests that do not need them. */
  envelopes?: {
    /** An own direct-chat event its recipient could not be sent now. */
    seal(convId: string, seq: number, to: string, event: Record<string, unknown>): void;
    /** The recipient holds every own event up to `upto`. */
    acked(convId: string, upto: number): void;
    carried(convId: string, seq: number): boolean;
  };
}

type Outcome = 'applied' | 'duplicate' | 'buffered' | 'held' | 'rejected';

const GENESIS: Record<string, 'group' | 'team'> = {
  'group.create': 'group',
  'team.create': 'team',
};

/** The member entry for `userId` in a genesis or self-join body, if its key checks out. */
function memberFromBody(ev: LogEvent, userId: string): Member | undefined {
  const members = (ev.body as { members?: unknown })?.members;
  if (!Array.isArray(members)) return undefined;
  const m = (members as Member[]).find((x) => x?.userId === userId);
  if (!m || typeof m.spki !== 'string') return undefined;
  try {
    return userIdFromSpki(decodeBase64Url(m.spki)) === userId ? m : undefined;
  } catch {
    return undefined;
  }
}

/** A `member.add` (not for a channel) that names `selfId`. */
function isInvitation(raw: unknown, selfId: string): boolean {
  const ev = raw as {
    type?: unknown;
    body?: { members?: Array<{ userId?: unknown }>; channelId?: unknown };
  };
  return (
    ev?.type === 'member.add' &&
    ev.body?.channelId === undefined &&
    Array.isArray(ev.body?.members) &&
    ev.body.members.some((m) => m?.userId === selfId)
  );
}

function isSelfJoin(ev: LogEvent): boolean {
  const body = ev.body as { members?: Array<{ userId?: string }>; channelId?: unknown };
  return (
    ev.type === 'member.add' &&
    body?.channelId === undefined &&
    Array.isArray(body?.members) &&
    body.members.length === 1 &&
    body.members[0]?.userId === ev.author
  );
}

/**
 * The conversation log: writes signed events, applies events from peers exactly once and
 * in order, forwards live events to members the sender could not reach, and swaps
 * whatever the other side is missing whenever a link opens.
 */
export class SyncEngine {
  private readonly o: SyncEngineOptions;
  /** Events that arrived ahead of a gap, keyed by `convId:author`. */
  private readonly buffered = new Map<string, Map<number, unknown>>();
  /** Events for conversations, or from authors, not known yet. */
  private readonly held = new Map<string, Array<{ from: string; raw: unknown }>>();
  /** Members that may lack events this PC holds. */
  private readonly pending = new Set<string>();
  /** Teams this PC is joining (their genesis may be accepted without listing us). */
  private readonly joining = new Set<string>();
  /** Groups and teams a held `member.add` adds us to (their genesis may not list us). */
  private readonly invited = new Set<string>();
  private readonly outbox = new Map<string, Array<{ event: unknown; sentTo: string[] }>>();
  private readonly summaryAfterFlush = new Set<string>();
  private flushQueued = false;
  private lastResync = 0;
  private lastGossip = 0;
  private gossipTurn = 0;
  /** When we last asked each peer for what we lack (to stop request ping-pong). */
  private readonly asked = new Map<string, number>();
  /** Membership fingerprints, to re-materialise only when history changed. */
  private readonly signatures = new Map<string, string>();
  readonly materializer: Materializer;
  readonly memberships: Memberships;

  constructor(options: SyncEngineOptions) {
    this.o = options;
    this.memberships = new Memberships(options.repo);
    this.materializer = new Materializer(
      options.selfId,
      options.messages,
      options.repo,
      (convId, author, hlc) => this.memberships.allowed(convId, author, hlc),
    );
    const { links } = options;
    links.on('typing', (from, body) => {
      const { convId } = TypingBody.parse(body);
      if (options.repo.isMember(convId, from)) options.events.typing(convId, from);
    });
    links.onLinkUp((userId) => this.sendSummary(userId));
    links.on('sync.summary', (from, body) => this.onSummary(from, SyncSummaryBody.parse(body)));
    links.on('sync.events', (from, body) => this.onEvents(from, SyncEventsBody.parse(body)));
    links.on('event.push', (from, body) => this.onPushes(from, [EventPushBody.parse(body)]));
    links.on('event.batch', (from, body) => this.onPushes(from, EventBatchBody.parse(body).pushes));
    links.on('event.ack', (from, body) => this.onAck(from, EventAckBody.parse(body)));
    links.on('team.fetch', (from, body) =>
      this.onTeamFetch(from, TeamFetchBody.parse(body).teamId),
    );
  }

  /** Recompute which peers may lack events (on start-up). */
  loadPending(peers: Iterable<string>): void {
    for (const p of peers) if (this.o.repo.hasAnyUnacked(p)) this.pending.add(p);
  }

  /**
   * Periodic anti-entropy (called every second; acts every RESYNC_MS): peers that may
   * still lack events get a fresh summary over their open link, which makes them answer
   * with what we lack and ask for what they lack. Covers pushes lost on a link that has
   * not noticed it is dead yet.
   */
  tick(): void {
    const now = this.o.clock.now();
    if (now - this.lastResync >= RESYNC_MS) {
      this.lastResync = now;
      for (const p of this.pending) if (this.o.links.isReady(p)) this.sendSummary(p);
    }
    // Background gossip: now and then compare with one connected colleague, in rotation,
    // even with nothing pending. This repairs what targeted sync cannot see, such as a
    // link that silently lost frames and recovered without reconnecting.
    if (now - this.lastGossip >= GOSSIP_MS) {
      this.lastGossip = now;
      const peers = this.o.links.readyPeers().sort();
      if (peers.length > 0) {
        const peer = peers[this.gossipTurn++ % peers.length]!;
        if (this.comparable(peer).length > 0) this.sendSummary(peer);
      }
    }
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

  /** Current members: derived for groups, teams and channels; the pair for direct chats. */
  members(convId: string): string[] {
    return [...this.memberships.current(convId).keys()];
  }

  /** Start a group or team: create its conversation and append its genesis event. */
  create(type: 'group.create' | 'team.create', body: Record<string, unknown>): string {
    const parsed = EVENT_BODIES[type].parse(body) as Record<string, unknown>;
    const convId = genesisConvId(type, this.o.selfId, parsed);
    const kind = GENESIS[type]!;
    this.o.repo.createConversation(
      convId,
      kind,
      { title: (parsed['title'] ?? parsed['name']) as string | undefined },
      this.o.clock.now(),
    );
    this.append(convId, type, parsed);
    return convId;
  }

  /** Sign, store and materialise an own event, then send it to every reachable member. */
  append(
    convId: string,
    type: EventType,
    body: Record<string, unknown>,
  ): { author: string; seq: number } {
    const { repo, selfId } = this.o;
    const conv = repo.get(convId);
    if (!conv) throw new Error('unknown conversation');
    const schema = (EVENT_BODIES as Record<string, { parse(v: unknown): unknown }>)[type];
    const parsed = (schema ? schema.parse(body) : body) as Record<string, unknown>;
    // Recipients: members before the event (a removed member still learns of the removal).
    const before = new Set(this.members(convId));
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
    if (MEMBERSHIP_EVENT_TYPES.has(type)) this.onMembershipChanged(convId);
    this.o.events.effects(fx, true);
    this.o.events.conversationsChanged([convId]);

    const recipients = new Set([...before, ...this.members(convId)]);
    recipients.delete(selfId);
    const pushed = [...recipients].filter((m) => this.o.links.isReady(m));
    const sentTo = [selfId, ...pushed];
    for (const member of recipients) {
      this.pending.add(member);
      if (pushed.includes(member)) this.enqueue(member, { event, sentTo });
      else {
        this.o.wantLink(member);
        // A direct chat's other person is offline: also seal it for them (M6).
        if (conv.kind === 'direct' && !this.o.isOnline(member))
          this.o.envelopes?.seal(convId, event.seq, member, event);
      }
    }
    return { author: selfId, seq: event.seq };
  }

  /**
   * Live pushes are queued per peer and flushed once the current task ends, so a burst
   * (a paste of many posts, a relay forwarding a backlog) travels as a few batch frames.
   */
  private enqueue(peer: string, push: { event: unknown; sentTo: string[] }): void {
    let queue = this.outbox.get(peer);
    if (!queue) this.outbox.set(peer, (queue = []));
    queue.push(push);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flushOutbox());
  }

  private flushOutbox(): void {
    this.flushQueued = false;
    const outbox = [...this.outbox];
    this.outbox.clear();
    for (const [peer, queue] of outbox) {
      let ok = true;
      if (queue.length === 1 || !this.o.links.hasCap(peer, 'teams.v1')) {
        for (const push of queue) ok = !!this.o.links.send(peer, 'event.push', push) && ok;
      } else {
        let batch: typeof queue = [];
        let bytes = 0;
        const send = () => {
          if (batch.length) ok = !!this.o.links.send(peer, 'event.batch', { pushes: batch }) && ok;
          batch = [];
          bytes = 0;
        };
        for (const push of queue) {
          const size = JSON.stringify(push).length;
          if (batch.length >= SYNC_BATCH_EVENTS || bytes + size > BATCH_BYTES) send();
          batch.push(push);
          bytes += size;
        }
        send();
      }
      // A link that went away: the events reach the peer at its next summary exchange.
      if (!ok) this.o.wantLink(peer);
    }
    const summaries = [...this.summaryAfterFlush];
    this.summaryAfterFlush.clear();
    for (const p of summaries) if (this.o.links.isReady(p)) this.sendSummary(p);
  }

  private onPushes(
    from: string,
    pushes: Array<{ event: unknown; sentTo?: string[] | undefined }>,
  ): void {
    const touched = new Map<string, number>();
    const applied: Array<{ event: LogEvent; raw: unknown; sentTo: string[] }> = [];
    for (const push of pushes) {
      const result = this.applyFrom(from, push.event, touched);
      if (result.outcome === 'applied' && result.event)
        applied.push({ event: result.event, raw: push.event, sentTo: push.sentTo ?? [] });
    }
    this.sendAcks(from, touched);
    for (const a of applied) this.forward(a.event, a.raw, a.sentTo, from);
  }

  /** Forward a new live event once, to members the sender did not reach directly. */
  private forward(ev: LogEvent, raw: unknown, sentTo: string[], from: string): void {
    const conv = this.o.repo.get(ev.convId);
    if (!conv || conv.kind === 'direct') return;
    const reached = new Set([...sentTo, from, ev.author, this.o.selfId]);
    const missing = this.members(ev.convId).filter((m) => !reached.has(m));
    if (missing.length === 0) return;
    const targets = missing.filter((m) => this.o.links.isReady(m));
    const next = [...reached, ...targets];
    for (const m of missing) {
      this.pending.add(m);
      if (!targets.includes(m)) this.o.wantLink(m);
    }
    for (const m of targets) this.enqueue(m, { event: raw, sentTo: next });
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
    if (others.some((m) => this.o.isOnline(m))) return 'sending';
    return this.o.envelopes?.carried(convId, seq) ? 'carried' : 'waiting';
  }

  /**
   * Apply an event that arrived sealed in an envelope (its author offline, a carrier
   * handing it over). The envelope was opened and its author's key checked by the caller.
   */
  applySealed(author: string, raw: unknown): void {
    const touched = new Map<string, number>();
    this.applyFrom(author, raw, touched);
    // Our acknowledgement reaches the author at the next summary exchange with them.
    if (touched.size > 0) this.pending.add(author);
  }

  /** Tell members with an open link that this user is typing (never dials for it). */
  sendTyping(convId: string): void {
    for (const member of this.o.repo.members(convId)) {
      if (member !== this.o.selfId) this.o.links.send(member, 'typing', { convId });
    }
  }

  /** Re-derive messages, reactions, pins, receipts and polls from the event log. */
  rebuild(): void {
    const { repo } = this.o;
    for (const kind of ['group', 'team'])
      for (const row of repo.byKind(kind)) this.memberships.invalidate(row.convId);
    repo.transaction(() => {
      this.o.messages.clearMaterialised();
      const fx = emptyEffects();
      for (const json of repo.allEvents()) {
        const parsed = LogEvent.safeParse(JSON.parse(json));
        if (parsed.success) this.materializer.apply(parsed.data, false, fx);
      }
    });
  }

  /** Re-derive one conversation, after its membership history changed. */
  private rematerialize(convId: string): void {
    const { repo } = this.o;
    repo.transaction(() => {
      this.o.messages.clearConversation(convId);
      const fx = emptyEffects();
      for (const json of repo.conversationEvents(convId)) {
        const parsed = LogEvent.safeParse(JSON.parse(json));
        if (parsed.success) this.materializer.apply(parsed.data, false, fx);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /**
   * A membership or control event was stored: rebuild the timeline, update members and
   * channel conversations, re-materialise what the change affects, and retry held events.
   */
  private onMembershipChanged(convId: string): void {
    const { repo, selfId } = this.o;
    const row = repo.get(convId);
    if (!row || (row.kind !== 'group' && row.kind !== 'team')) return;
    this.memberships.invalidate(convId);
    const tl = this.memberships.timeline(convId);
    if (!tl) return;
    for (const [userId, { spki }] of tl.keys) {
      if (userId !== selfId) this.o.events.learnKey(userId, Buffer.from(decodeBase64Url(spki)));
    }
    const changed = [convId];
    repo.updateDerived(convId, tl.title ?? null, {
      ...(tl.description && { description: tl.description }),
      ...(tl.visibility && { visibility: tl.visibility }),
      ...(tl.creator && { creator: tl.creator }),
    });
    const joined: string[] = [];
    const setMembers = (id: string, members: Map<string, Role>) => {
      const was = repo.isMember(id, selfId);
      repo.setMembers(id, members);
      if (!was && members.has(selfId)) joined.push(id);
    };
    setMembers(convId, tl.valid ? tl.scope.current : new Map());
    const remat = (id: string, signature: string) => {
      if (this.signatures.get(id) === signature) return;
      this.signatures.set(id, signature);
      this.rematerialize(id);
    };
    if (row.kind === 'group') remat(convId, tl.scope.signature());
    for (const ch of tl.channels.values()) {
      const scope = ch.scope ?? tl.scope;
      let crow = repo.get(ch.channelId);
      if (!crow && scope.current.has(selfId)) {
        crow = repo.createConversation(
          ch.channelId,
          'channel',
          { teamId: convId, title: ch.name },
          this.o.clock.now(),
        );
      }
      if (!crow) continue;
      repo.updateDerived(ch.channelId, ch.name, {
        private: ch.private,
        archived: ch.archived,
        general: ch.general,
        ...(ch.description && { description: ch.description }),
      });
      setMembers(ch.channelId, scope.current);
      remat(ch.channelId, scope.signature());
      changed.push(ch.channelId);
    }
    this.o.events.membershipChanged(changed);
    // New members need the history: they get it at their next summary exchange.
    for (const m of tl.scope.current.keys()) if (m !== selfId) this.pending.add(m);
    for (const id of changed) this.replayHeld(id);
    // Just joined: ask a few members who are online for the history. Queued after the
    // pushes of this change, so they already count us as a member when they answer.
    if (joined.length > 0) {
      const peers = new Set(joined.flatMap((id) => repo.members(id)));
      peers.delete(selfId);
      const ready = [...peers].filter((p) => this.o.links.isReady(p)).slice(0, 3);
      for (const p of ready) this.summaryAfterFlush.add(p);
      this.scheduleFlush();
    }
  }

  private hold(convId: string, from: string, raw: unknown): Outcome {
    let list = this.held.get(convId);
    if (!list) {
      if (this.held.size >= MAX_HELD_CONVS)
        return this.reject(from, 'too many unknown conversations');
      this.held.set(convId, (list = []));
      // Something we cannot place yet (we were just added, or a membership change is on
      // its way): ask the sender for everything we share, which now includes this.
      if (this.o.links.isReady(from)) this.sendSummary(from);
    }
    if (isInvitation(raw, this.o.selfId)) this.invited.add(convId);
    if (list.length < MAX_HELD_PER_CONV) list.push({ from, raw });
    return 'held';
  }

  private replayHeld(convId: string): void {
    const list = this.held.get(convId);
    if (!list) return;
    this.held.delete(convId);
    const byFrom = new Map<string, Map<string, number>>();
    for (const { from, raw } of list) {
      let touched = byFrom.get(from);
      if (!touched) byFrom.set(from, (touched = new Map()));
      this.applyFrom(from, raw, touched);
    }
    for (const [from, touched] of byFrom) this.sendAcks(from, touched);
  }

  /** May this genesis create a conversation here? It must be genuine and include us. */
  private acceptGenesis(ev: LogEvent): boolean {
    const kind = GENESIS[ev.type];
    if (!kind || ev.seq !== 1) return false;
    const parsed = EVENT_BODIES[ev.type as 'group.create' | 'team.create'].safeParse(ev.body);
    if (
      !parsed.success ||
      genesisConvId(ev.type as 'group.create', ev.author, ev.body) !== ev.convId
    )
      return false;
    const listed = parsed.data.members.some((m) => m.userId === this.o.selfId);
    // Added later than the genesis: a held `member.add` names us. The timeline decides
    // whether that addition was authorised; until then the conversation shows as inactive.
    return (
      listed || this.invited.has(ev.convId) || (kind === 'team' && this.joining.has(ev.convId))
    );
  }

  /** Answer a join request: the control log of a public team this PC belongs to. */
  private onTeamFetch(from: string, teamId: string) {
    const tl = this.memberships.timeline(teamId);
    if (!tl?.valid || tl.visibility !== 'public' || !tl.scope.current.has(this.o.selfId)) return;
    const events: unknown[] = [];
    for (const json of this.o.repo.conversationEvents(teamId)) {
      if (events.length >= SYNC_BATCH_EVENTS) break;
      events.push(JSON.parse(json));
    }
    void from;
    return { type: 'team.data', body: { teamId, events } };
  }

  /** Join a public team through a member: fetch its control log, then add ourselves. */
  async joinTeam(teamId: string, via: string, self: Member): Promise<void> {
    const reply = await this.o.links.request(via, 'team.fetch', { teamId });
    const body = TeamDataBody.safeParse(reply.body);
    if (!body.success || body.data.teamId !== teamId)
      throw new Error('the team could not be fetched');
    this.joining.add(teamId);
    try {
      const touched = new Map<string, number>();
      for (const raw of body.data.events) this.applyFrom(via, raw, touched);
    } finally {
      this.joining.delete(teamId);
    }
    const tl = this.memberships.timeline(teamId);
    if (!tl?.valid) throw new Error('the team could not be verified');
    if (tl.visibility !== 'public') throw new Error('the team is private');
    if (!tl.scope.current.has(this.o.selfId))
      this.append(teamId, 'member.add', { members: [self] });
  }

  // -------------------------------------------------------------------------
  // Anti-entropy
  // -------------------------------------------------------------------------

  /**
   * Conversations to compare with a peer: every one we both belong to, plus every group,
   * team or channel either of us has belonged to with them in it at some point (in our
   * view). The extra ones let a member who missed their own addition or removal catch
   * up; what is actually sent is decided per conversation in `onSummary`.
   */
  private comparable(peer: string): string[] {
    const { repo, selfId } = this.o;
    const ids = new Set(repo.sharedWith(peer, selfId));
    for (const convId of repo.multiParty()) {
      if (ids.has(convId)) continue;
      if (this.memberships.ever(convId, peer) && this.memberships.ever(convId, selfId))
        ids.add(convId);
    }
    return [...ids];
  }

  private sendSummary(userId: string): void {
    // Current shared conversations come first, so a cap never drops them.
    const convs = this.comparable(userId)
      .slice(0, MAX_SYNC_SUMMARY_CONVERSATIONS)
      .map((convId) => ({
        convId,
        heads: this.o.repo.heads(convId),
      }));
    this.o.links.send(userId, 'sync.summary', { convs });
  }

  private onSummary(from: string, summary: SyncSummaryBody): void {
    const { repo, selfId } = this.o;
    const theirs = new Map(summary.convs.map((c) => [c.convId, c.heads]));
    // What they hold tells us what they have received: raise acks.
    for (const [convId, heads] of theirs) {
      if (!repo.isMember(convId, from)) continue;
      for (const [author, seq] of Object.entries(heads)) this.raiseAck(convId, from, author, seq);
    }
    // They hold events we lack: ask for them (at most every few seconds per peer, since
    // events we hold back for now, such as from unknown authors, keep heads apart).
    let behind = false;
    for (const [convId, heads] of theirs) {
      if (!repo.get(convId)) continue;
      const mine = repo.heads(convId);
      for (const [author, seq] of Object.entries(heads))
        if (seq > (mine[author] ?? 0)) behind = true;
    }
    // Send what they lack, up to the per-reply limit.
    let budget: number = LINK_LIMITS.eventsPerSyncReply;
    let batch: unknown[] = [];
    let bytes = 0;
    let exhausted = false;
    const flush = (more: boolean) => {
      if (batch.length === 0 && !more) return;
      this.o.links.send(from, 'sync.events', { events: batch, ...(more && { more: true }) });
      batch = [];
      bytes = 0;
    };
    // To a current member (in our view), everything; to a former member, everything up to
    // the moment they left (so they learn of their removal, and never of anything after).
    const serve: Array<{ convId: string; upto?: { t: number; c: number } }> = [];
    for (const convId of new Set([...repo.sharedWith(from, selfId), ...theirs.keys()])) {
      if (!repo.get(convId)) continue;
      if (repo.isMember(convId, from)) serve.push({ convId });
      else {
        const upto = this.memberships.leftAt(convId, from);
        if (upto) serve.push({ convId, upto });
      }
    }
    outer: for (const { convId, upto } of serve) {
      const their = theirs.get(convId) ?? {};
      for (const [author, mine] of Object.entries(repo.heads(convId))) {
        let after = their[author] ?? 0;
        while (after < mine) {
          if (budget <= 0) {
            exhausted = true;
            flush(true);
            break outer;
          }
          const rows = repo.eventsAfter(
            convId,
            author,
            after,
            Math.min(SYNC_BATCH_EVENTS, budget),
            upto,
          );
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
    // A former member who was re-added after leaving, by someone whose right to do so they
    // cannot check, also gets the membership events up to that re-addition: enough to see
    // whether it stands, and no posts.
    for (const { convId, upto } of serve) {
      if (!upto || exhausted) continue;
      const claim = this.lastAddOf(convId, from);
      if (!claim || claim.t < upto.t || (claim.t === upto.t && claim.c <= upto.c)) continue;
      for (const json of repo.eventsInHlcRange(convId, [...MEMBERSHIP_EVENT_TYPES], upto, claim)) {
        const size = Buffer.byteLength(json);
        if (batch.length >= SYNC_BATCH_EVENTS || bytes + size > BATCH_BYTES) flush(false);
        batch.push(JSON.parse(json));
        bytes += size;
      }
    }
    flush(false);
    // Everything they lacked is on its way.
    if (!exhausted) this.pending.delete(from);
    const now = this.o.clock.now();
    if (behind && now - (this.asked.get(from) ?? -Infinity) >= ASK_INTERVAL_MS) {
      this.asked.set(from, now);
      this.sendSummary(from);
    }
  }

  /** The HLC of the latest `member.add` naming `userId` in a conversation's control log. */
  private lastAddOf(convId: string, userId: string): { t: number; c: number } | undefined {
    const conv = this.o.repo.get(convId);
    const logId = conv?.kind === 'channel' ? conv.teamId : convId;
    if (!logId) return undefined;
    let last: { t: number; c: number } | undefined;
    for (const json of this.o.repo.eventsOfTypes(logId, ['member.add'])) {
      const ev = JSON.parse(json) as LogEvent & { body: { members?: Array<{ userId?: string }> } };
      if (!ev.body.members?.some((m) => m.userId === userId)) continue;
      if (!last || ev.hlc.t > last.t || (ev.hlc.t === last.t && ev.hlc.c > last.c)) last = ev.hlc;
    }
    return last;
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
    if (repo.get(convId)?.kind === 'direct') this.o.envelopes?.acked(convId, upto);
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

  /** The key an event's author signs with, from a link, a member list, or the event itself. */
  private authorKey(ev: LogEvent, selfJoinOrGenesis: boolean): KeyObject | undefined {
    if (ev.author === this.o.selfId) return this.o.publicKey;
    const known = this.o.keyFor(ev.author);
    if (known) return known;
    const spki =
      this.memberships.keyOf(ev.convId, ev.author) ??
      (selfJoinOrGenesis ? memberFromBody(ev, ev.author)?.spki : undefined);
    if (!spki) return undefined;
    try {
      return importPublicKeySpki(decodeBase64Url(spki));
    } catch {
      return undefined;
    }
  }

  /** Validate and apply one event received from `from`; records the new head in `touched`. */
  private applyFrom(
    from: string,
    raw: unknown,
    touched: Map<string, number>,
  ): { outcome: Outcome; event?: LogEvent } {
    const parsed = LogEvent.safeParse(raw);
    if (!parsed.success) return { outcome: this.reject(from, 'malformed event') };
    const ev = parsed.data;
    const { repo, selfId } = this.o;

    let conv = repo.get(ev.convId);
    if (!conv) {
      if (ev.convId === this.directConvId(from) && (ev.author === from || ev.author === selfId)) {
        // A first message in a 1:1 chat creates the conversation on the receiving side.
        conv = repo.createDirect(ev.convId, selfId, from, this.o.clock.now());
        this.o.events.conversationsChanged([ev.convId]);
      } else if (this.acceptGenesis(ev)) {
        const body = ev.body as { title?: string; name?: string };
        conv = repo.createConversation(
          ev.convId,
          GENESIS[ev.type]!,
          { title: body.title ?? body.name },
          this.o.clock.now(),
        );
      } else {
        // A channel not created here yet, or a group whose genesis has not arrived.
        return { outcome: this.hold(ev.convId, from, raw) };
      }
    }

    let special = false;
    if (conv.kind === 'direct') {
      if (!repo.isMember(conv.convId, ev.author))
        return { outcome: this.reject(from, 'author is not a member') };
      if (!repo.isMember(conv.convId, from))
        return { outcome: this.reject(from, 'sender is not a member') };
    } else {
      special =
        (ev.seq === 1 && GENESIS[ev.type] === conv.kind) ||
        (conv.kind === 'team' && isSelfJoin(ev));
      // Authors and relays must have been members at some point; until we know that
      // (their membership event may still be on its way), the event waits.
      if (!special && !this.memberships.ever(conv.convId, ev.author))
        return { outcome: this.hold(ev.convId, from, raw) };
      // (A genesis is self-certifying, so whoever relays it needs no membership check.)
      if (
        !special &&
        from !== ev.author &&
        from !== selfId &&
        !this.memberships.ever(conv.convId, from)
      ) {
        return { outcome: this.hold(ev.convId, from, raw) };
      }
    }

    const key = this.authorKey(ev, special);
    if (!key) return { outcome: this.hold(ev.convId, from, raw) };
    if (!verifyRecord(key, raw)) return { outcome: this.reject(from, 'bad signature') };

    const bufKey = `${ev.convId}:${ev.author}`;
    const head = repo.head(ev.convId, ev.author);
    if (ev.seq <= head) {
      touched.set(bufKey, head);
      return { outcome: 'duplicate' };
    }
    if (ev.seq > head + 1) {
      let buf = this.buffered.get(bufKey);
      if (!buf) this.buffered.set(bufKey, (buf = new Map()));
      if (buf.size < MAX_BUFFERED) buf.set(ev.seq, raw);
      // A membership event ahead of its author's earlier events still counts for the
      // timeline (a former member is sent these without the posts in between).
      if (MEMBERSHIP_EVENT_TYPES.has(ev.type) && conv.kind !== 'direct') {
        if (repo.insertSparse(ev, JSON.stringify(raw))) this.onMembershipChanged(ev.convId);
      }
      return { outcome: 'buffered' };
    }

    const fx = emptyEffects();
    let next: { ev: LogEvent; raw: unknown } | undefined = { ev, raw };
    let newHead = head;
    let membership = false;
    repo.transaction(() => {
      while (next) {
        this.store(next.ev, next.raw, fx);
        if (MEMBERSHIP_EVENT_TYPES.has(next.ev.type)) membership = true;
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
    if (membership) this.onMembershipChanged(ev.convId);
    this.o.events.effects(fx, false);
    this.o.events.conversationsChanged([ev.convId]);
    return { outcome: 'applied', event: ev };
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

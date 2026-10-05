import { randomBytes, type KeyObject } from 'node:crypto';
import {
  CALL_RING_MS,
  CallAcceptBody,
  CallControlBody,
  CallDeclineBody,
  CallIceBody,
  CallIdBody,
  CallInviteBody,
  CallJoinBody,
  CallReactionBody,
  CallSdpBody,
  CallStateBody,
  encodeBase32,
  MAX_CALL_PARTICIPANTS,
  MAX_VIDEO_CALL_PARTICIPANTS,
  type CALL_REACTIONS,
  type CallDeclineReason,
  type CallMedia,
  type CallParticipant,
} from '@officemesh/protocol';
import type { CallHistoryItem, CallSignal } from '@officemesh/protocol/ipc';
import { signRecord, verifyRecord } from '../identity/crypto.ts';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';
import type { LinkManager } from '../link/link-manager.ts';
import type { CallRepo } from '../store/calls.ts';

export type CallOutcome = NonNullable<CallHistoryItem['outcome']>;

export interface CallSession {
  callId: string;
  convId?: string | undefined;
  media: CallMedia;
  direction: 'in' | 'out';
  state: 'ringing' | 'outgoing' | 'active';
  /** The inviter (incoming) or this user (outgoing). */
  caller: string;
  /** People invited by this PC who have not joined or declined yet. */
  invited: Set<string>;
  declines: Map<string, CallDeclineReason>;
  roster: Map<string, CallParticipant>;
  startedAt: number;
  answeredAt?: number;
  /** Who started the call; may mute everyone, remove people and spotlight. */
  organizer: string;
  /** A meeting (Meet now or scheduled): stays open while anyone is in it, even alone. */
  open: boolean;
}

export interface CallManagerEvents {
  /** The current call changed (null: there is none). */
  changed(call: CallSession | null): void;
  /** The current call ended, and why. */
  ended(call: CallSession, outcome: CallOutcome): void;
  /** A WebRTC signal for the renderer. */
  signal(callId: string, from: string, signal: CallSignal): void;
  /** A call rings here (for a toast). */
  incoming(call: CallSession): void;
  /** Nobody answered an invitation to this PC (or it declined automatically). */
  missed(call: CallSession, auto: 'dnd' | 'busy' | null): void;
  historyChanged(): void;
  /** A live reaction from a participant. */
  reaction(callId: string, from: string, emoji: (typeof CALL_REACTIONS)[number]): void;
  /** The organiser muted or removed this user. */
  controlled(callId: string, action: 'mute' | 'remove'): void;
}

export interface CallManagerOptions {
  selfId: string;
  privateKey: KeyObject;
  links: LinkManager;
  /** Open (or reuse) a link to a colleague. */
  connect(userId: string): Promise<boolean>;
  keyFor(userId: string): KeyObject | undefined;
  /** True when the user chose Do not disturb. */
  doNotDisturb(): boolean;
  /** May this colleague join a meeting held in this conversation? (They must be a member.) */
  mayJoin(convId: string, userId: string): boolean;
  repo: CallRepo;
  clock: Clock;
  logger: Logger;
  events: CallManagerEvents;
}

const SPOKE_MIN_INTERVAL_MS = 1_000;

/** The DTLS fingerprint line of an SDP (the first one; Chromium writes one per session). */
export function sdpFingerprint(sdp: string): string | undefined {
  return /^a=fingerprint:(.+)$/m.exec(sdp)?.[1]?.trim();
}

function newCallId(): string {
  return encodeBase32(randomBytes(20));
}

/**
 * Call signaling (plan section 9). Media flows directly between the PCs' renderers over
 * WebRTC; this class rings and answers, relays SDP (signed, binding the DTLS fingerprint
 * to the sender's identity) and ICE, replicates the call roster among participants, and
 * keeps call history. At most one call exists at a time: a second invitation, or one
 * while the user is in Do not disturb, is declined automatically with the reason.
 */
export class CallManager {
  private readonly o: CallManagerOptions;
  private current: CallSession | undefined;
  private ringTimer: TimerHandle | undefined;
  private readonly inviteTimers = new Map<string, TimerHandle>();
  private lastSpoke = 0;
  /** Meetings this user asked to join: the first invitation for one is accepted at once. */
  private readonly joining = new Map<
    string,
    {
      video: boolean;
      resolve: (c: CallSession) => void;
      reject: (e: Error) => void;
      timer: TimerHandle;
    }
  >();

  constructor(options: CallManagerOptions) {
    this.o = options;
    const { links } = options;
    links.on('call.invite', (from, body) => this.onInvite(from, body));
    links.on('call.ringing', () => {});
    links.on('call.accept', (from, body) => this.onAccept(from, body));
    links.on('call.decline', (from, body) => this.onDecline(from, body));
    links.on('call.hangup', (from, body) => this.onHangup(from, body));
    links.on('call.state', (from, body) => this.onState(from, body));
    links.on('call.sdp', (from, body) => this.onSdp(from, body));
    links.on('call.ice', (from, body) => this.onIce(from, body));
    links.on('call.join', (from, body) => this.onJoin(from, body));
    links.on('call.reaction', (from, body) => this.onReaction(from, body));
    links.on('call.control', (from, body) => this.onControl(from, body));
    options.repo.closeDangling(options.clock.now());
  }

  get call(): CallSession | undefined {
    return this.current;
  }

  get inCall(): boolean {
    return this.current?.state === 'active' || this.current?.state === 'outgoing';
  }

  // -------------------------------------------------------------------------
  // Commands from this user
  // -------------------------------------------------------------------------

  start(input: {
    convId?: string | undefined;
    userIds: string[];
    media: CallMedia;
    /** A meeting: may start with nobody invited, and stays open while anyone is in it. */
    open?: boolean;
    callId?: string;
  }): CallSession {
    if (this.current) throw new Error('you are already in a call');
    const invitees = [...new Set(input.userIds)].filter((u) => u !== this.o.selfId);
    if (invitees.length === 0 && !input.open) throw new Error('nobody to call');
    if (invitees.length + 1 > MAX_CALL_PARTICIPANTS) {
      throw new Error(`a call can have at most ${MAX_CALL_PARTICIPANTS} people`);
    }
    const now = this.o.clock.now();
    const media: CallMedia =
      invitees.length + 1 > MAX_VIDEO_CALL_PARTICIPANTS ? 'audio' : input.media;
    const call: CallSession = {
      callId: input.callId ?? newCallId(),
      ...(input.convId && { convId: input.convId }),
      media,
      direction: 'out',
      // A meeting is in progress as soon as its organiser is in it.
      state: input.open ? 'active' : 'outgoing',
      caller: this.o.selfId,
      invited: new Set(),
      declines: new Map(),
      roster: new Map([[this.o.selfId, this.selfEntry(now, media === 'video')]]),
      startedAt: now,
      organizer: this.o.selfId,
      open: input.open === true,
      ...(input.open && { answeredAt: now }),
    };
    this.current = call;
    this.o.repo.begin({
      callId: call.callId,
      convId: call.convId,
      direction: 'out',
      media,
      peers: invitees,
      startedAt: now,
    });
    for (const u of invitees) this.sendInvite(call, u);
    this.changed();
    this.o.events.historyChanged();
    return call;
  }

  /** Add people to the current call. */
  invite(callId: string, userIds: string[]): CallSession {
    const call = this.require(callId);
    if (call.state === 'ringing') throw new Error('answer the call first');
    const present = this.members(call).length + call.invited.size;
    const fresh = userIds.filter((u) => u !== this.o.selfId && !this.members(call).includes(u));
    if (present + fresh.length > MAX_CALL_PARTICIPANTS) {
      throw new Error(`a call can have at most ${MAX_CALL_PARTICIPANTS} people`);
    }
    for (const u of fresh) this.sendInvite(call, u);
    this.o.repo.setPeers(call.callId, [...new Set([...this.peersOf(call), ...fresh])]);
    this.changed();
    return call;
  }

  accept(callId: string, video: boolean): CallSession {
    const call = this.require(callId);
    if (call.state !== 'ringing') throw new Error('this call is not ringing');
    this.stopRing();
    const now = this.o.clock.now();
    call.state = 'active';
    call.answeredAt = now;
    const self = this.selfEntry(now, video && call.media === 'video');
    call.roster.set(this.o.selfId, self);
    this.o.repo.answered(call.callId, now);
    this.o.links.send(call.caller, 'call.accept', { callId, participant: self });
    this.broadcastState(call);
    this.changed();
    this.o.events.historyChanged();
    return call;
  }

  decline(callId: string): void {
    const call = this.require(callId);
    if (call.state !== 'ringing') throw new Error('this call is not ringing');
    this.o.links.send(call.caller, 'call.decline', { callId, reason: 'declined' });
    this.finish(call, 'declined');
  }

  hangup(callId: string): void {
    const call = this.current;
    if (!call || call.callId !== callId) return;
    if (call.state === 'ringing') {
      this.decline(callId);
      return;
    }
    for (const u of [...this.members(call), ...call.invited]) {
      if (u !== this.o.selfId) this.o.links.send(u, 'call.hangup', { callId });
    }
    this.finish(call, call.answeredAt !== undefined ? 'completed' : 'cancelled');
  }

  update(
    callId: string,
    change: {
      muted?: boolean;
      video?: boolean;
      sharing?: boolean;
      onHold?: boolean;
      spoke?: boolean;
      hand?: boolean;
      recording?: boolean;
    },
  ): void {
    const call = this.require(callId);
    const self = call.roster.get(this.o.selfId);
    if (!self || call.state === 'ringing') return;
    const now = this.o.clock.now();
    if (change.spoke) {
      // Speaking starts are gossiped at most once a second.
      if (now - this.lastSpoke < SPOKE_MIN_INTERVAL_MS) return;
      this.lastSpoke = now;
    }
    const next: CallParticipant = {
      ...self,
      ...(change.muted !== undefined && { muted: change.muted }),
      ...(change.video !== undefined && { video: change.video && call.media === 'video' }),
      ...(change.sharing !== undefined && { sharing: change.sharing }),
      ...(change.onHold !== undefined && { onHold: change.onHold }),
      ...(change.hand !== undefined && { hand: change.hand }),
      ...(change.recording !== undefined && { recording: change.recording }),
      ...(change.spoke && { lastSpokeAt: now }),
      v: self.v + 1,
    };
    call.roster.set(this.o.selfId, next);
    this.broadcastState(call);
    this.changed();
  }

  /** The renderer lost the media connection to a participant: drop them for everyone. */
  dropped(callId: string, userId: string): void {
    const call = this.require(callId);
    const entry = call.roster.get(userId);
    if (!entry || entry.left || userId === this.o.selfId) return;
    call.roster.set(userId, { ...entry, left: true, v: entry.v + 1 });
    this.broadcastState(call);
    // Tell them too, if they can still be reached: their call ends rather than limping on.
    this.o.links.send(userId, 'call.state', this.stateBody(call));
    this.changed();
    this.afterLeave(call);
  }

  /** Relay a WebRTC signal from this user's renderer to another participant. */
  signal(callId: string, to: string, signal: CallSignal): void {
    const call = this.require(callId);
    if (signal.kind === 'sdp') {
      const fingerprint = sdpFingerprint(signal.sdp);
      if (!fingerprint) throw new Error('the session description has no DTLS fingerprint');
      const body = signRecord(this.o.privateKey, {
        callId: call.callId,
        from: this.o.selfId,
        to,
        type: signal.type,
        sdp: signal.sdp,
        fingerprint,
      });
      this.sendTo(to, 'call.sdp', body);
    } else {
      this.sendTo(to, 'call.ice', { callId: call.callId, candidate: signal.candidate });
    }
  }

  /**
   * Join a meeting announced in a conversation: ask its participants (`via`, the online
   * members) to invite us; the first invitation is accepted at once. Rejects if nobody in
   * the meeting answers.
   */
  join(
    callId: string,
    convId: string,
    via: string[],
    video: boolean,
    timeoutMs = 5_000,
  ): Promise<CallSession> {
    if (this.current) return Promise.reject(new Error('you are already in a call'));
    this.joining.get(callId)?.reject(new Error('superseded'));
    return new Promise((resolve, reject) => {
      const timer = this.o.clock.setTimeout(() => {
        this.joining.delete(callId);
        reject(new Error('this meeting has ended'));
      }, timeoutMs);
      this.joining.set(callId, { video, resolve, reject, timer });
      for (const u of via) {
        if (u === this.o.selfId) continue;
        void this.o
          .connect(u)
          .then((ok) => ok && this.o.links.send(u, 'call.join', { callId, convId }));
      }
    });
  }

  /** Ask one colleague to let us into the meeting we are in (two halves of one meeting merge). */
  requestMerge(userId: string): void {
    const call = this.current;
    if (!call?.convId || call.roster.has(userId)) return;
    void this.o
      .connect(userId)
      .then(
        (ok) =>
          ok &&
          this.o.links.send(userId, 'call.join', { callId: call.callId, convId: call.convId }),
      );
  }

  react(callId: string, emoji: (typeof CALL_REACTIONS)[number]): void {
    const call = this.require(callId);
    for (const u of this.members(call)) {
      if (u !== this.o.selfId) this.o.links.send(u, 'call.reaction', { callId, emoji });
    }
    this.o.events.reaction(callId, this.o.selfId, emoji);
  }

  /** Organiser controls (plan section 9): mute one or everyone, remove someone, spotlight. */
  control(callId: string, action: 'mute' | 'remove' | 'spotlight', target: string | null): void {
    const call = this.require(callId);
    if (call.organizer !== this.o.selfId) throw new Error('only the organiser can do that');
    if (action === 'spotlight') {
      const self = call.roster.get(this.o.selfId)!;
      call.roster.set(this.o.selfId, { ...self, spotlight: target, v: self.v + 1 });
      this.broadcastState(call);
      this.changed();
      return;
    }
    const targets = target ? [target] : this.members(call).filter((u) => u !== this.o.selfId);
    for (const u of targets) this.o.links.send(u, 'call.control', { callId, action, target: u });
    if (action === 'remove' && target) {
      const entry = call.roster.get(target);
      if (entry && !entry.left) {
        call.roster.set(target, { ...entry, left: true, v: entry.v + 1 });
        this.broadcastState(call);
        this.changed();
      }
    }
  }

  stop(): void {
    for (const j of this.joining.values()) this.o.clock.clearTimeout(j.timer);
    this.joining.clear();
    const call = this.current;
    if (call) this.hangup(call.callId);
    this.stopRing();
    for (const t of this.inviteTimers.values()) this.o.clock.clearTimeout(t);
    this.inviteTimers.clear();
  }

  // -------------------------------------------------------------------------
  // Messages from colleagues
  // -------------------------------------------------------------------------

  private onInvite(from: string, raw: unknown): void {
    const parsed = CallInviteBody.safeParse(raw);
    if (!parsed.success) return;
    const body = parsed.data;
    const now = this.o.clock.now();
    if (this.current?.callId === body.callId) {
      // The same meeting started twice (two people pressed Join at once): merge into one.
      const call = this.current;
      if (call.state === 'ringing') return;
      for (const p of body.participants)
        if (!call.roster.has(p.userId)) call.roster.set(p.userId, p);
      this.o.links.send(from, 'call.accept', {
        callId: call.callId,
        participant: call.roster.get(this.o.selfId)!,
      });
      this.broadcastState(call);
      this.changed();
      return;
    }
    const call: CallSession = {
      callId: body.callId,
      ...(body.convId && { convId: body.convId }),
      media: body.media,
      direction: 'in',
      state: 'ringing',
      caller: from,
      invited: new Set(),
      declines: new Map(),
      roster: new Map(body.participants.filter((p) => !p.left).map((p) => [p.userId, p])),
      startedAt: now,
      organizer: body.organizer ?? from,
      open: this.joining.has(body.callId) || body.meeting === true,
    };
    this.o.repo.begin({
      callId: call.callId,
      convId: call.convId,
      direction: 'in',
      media: call.media,
      peers: [from, ...[...call.roster.keys()].filter((u) => u !== from && u !== this.o.selfId)],
      startedAt: now,
    });
    // Busy, Do not disturb or full: decline at once with the reason; the caller sees why.
    const auto: CallDeclineReason | null = this.current
      ? 'busy'
      : this.o.doNotDisturb()
        ? 'dnd'
        : call.roster.size + 1 > MAX_CALL_PARTICIPANTS
          ? 'full'
          : null;
    if (auto) {
      this.o.links.send(from, 'call.decline', { callId: body.callId, reason: auto });
      this.o.repo.end(call.callId, now, auto === 'full' ? 'declined' : auto);
      if (auto !== 'full') this.o.events.missed(call, auto);
      this.o.events.historyChanged();
      return;
    }
    this.current = call;
    // We asked to join this meeting: no ringing, straight in.
    const join = this.joining.get(body.callId);
    if (join) {
      this.joining.delete(body.callId);
      this.o.clock.clearTimeout(join.timer);
      this.o.events.historyChanged();
      join.resolve(this.accept(call.callId, join.video));
      return;
    }
    this.o.links.send(from, 'call.ringing', { callId: body.callId });
    this.ringTimer = this.o.clock.setTimeout(() => {
      if (this.current !== call || call.state !== 'ringing') return;
      this.o.links.send(from, 'call.decline', { callId: call.callId, reason: 'timeout' });
      this.o.events.missed(call, null);
      this.finish(call, 'missed');
    }, CALL_RING_MS);
    this.o.events.incoming(call);
    this.changed();
    this.o.events.historyChanged();
  }

  private onAccept(from: string, raw: unknown): void {
    const parsed = CallAcceptBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    if (!call.invited.has(from) || parsed.data.participant.userId !== from) return;
    this.clearInvite(from);
    call.invited.delete(from);
    call.roster.set(from, { ...parsed.data.participant, left: false });
    if (call.state === 'outgoing') {
      call.state = 'active';
      call.answeredAt = this.o.clock.now();
      this.o.repo.answered(call.callId, call.answeredAt);
      this.o.events.historyChanged();
    }
    // Everyone learns of the newcomer; the newcomer connects to everyone.
    this.broadcastState(call);
    this.changed();
  }

  private onDecline(from: string, raw: unknown): void {
    const parsed = CallDeclineBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    if (call.state === 'ringing') {
      // The caller's PC gave up ringing us.
      if (from === call.caller) {
        this.o.events.missed(call, null);
        this.finish(call, 'missed');
      }
      return;
    }
    if (!call.invited.has(from)) return;
    this.clearInvite(from);
    call.invited.delete(from);
    call.declines.set(from, parsed.data.reason);
    this.changed();
    this.afterLeave(call);
  }

  private onHangup(from: string, raw: unknown): void {
    const parsed = CallIdBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    if (call.state === 'ringing') {
      if (from !== call.caller) return;
      this.o.events.missed(call, null);
      this.finish(call, 'missed');
      return;
    }
    const entry = call.roster.get(from);
    if (!entry || entry.left) return;
    call.roster.set(from, { ...entry, left: true, v: entry.v + 1 });
    this.changed();
    this.afterLeave(call);
  }

  private onState(from: string, raw: unknown): void {
    const parsed = CallStateBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    if (call.state === 'ringing') return;
    if (!call.roster.has(from) && !call.invited.has(from) && from !== call.caller) return;
    let changed = false;
    for (const p of parsed.data.participants) {
      const mine = call.roster.get(p.userId);
      // Highest version wins; at equal versions "left" wins, so a drop is never undone.
      if (mine && (mine.v > p.v || (mine.v === p.v && (mine.left || !p.left)))) continue;
      if (p.userId === this.o.selfId) {
        // Someone dropped us (they lost our media). We are no longer in this call.
        if (p.left && mine && !mine.left) {
          this.finish(call, 'completed');
          return;
        }
        continue;
      }
      call.roster.set(p.userId, p);
      call.invited.delete(p.userId);
      changed = true;
    }
    if (!changed) return;
    if (call.state === 'outgoing' && this.members(call).length > 1) {
      call.state = 'active';
      call.answeredAt = this.o.clock.now();
      this.o.repo.answered(call.callId, call.answeredAt);
    }
    this.o.repo.setPeers(call.callId, this.peersOf(call));
    this.changed();
    this.afterLeave(call);
  }

  private onSdp(from: string, raw: unknown): void {
    const parsed = CallSdpBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId || call.state === 'ringing')
      return;
    const body = parsed.data;
    if (body.from !== from || body.to !== this.o.selfId) return;
    const key = this.o.keyFor(from);
    if (!key || !verifyRecord(key, raw)) {
      this.o.logger.warn('call.sdp with a bad signature', { from });
      return;
    }
    if (sdpFingerprint(body.sdp) !== body.fingerprint) {
      this.o.logger.warn('call.sdp fingerprint does not match the signed one', { from });
      return;
    }
    this.o.events.signal(call.callId, from, { kind: 'sdp', type: body.type, sdp: body.sdp });
  }

  private onIce(from: string, raw: unknown): void {
    const parsed = CallIceBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId || call.state === 'ringing')
      return;
    this.o.events.signal(call.callId, from, { kind: 'ice', candidate: parsed.data.candidate });
  }

  /** A colleague asks to join the meeting we are in: invite them if they belong to its chat. */
  private onJoin(from: string, raw: unknown): void {
    const parsed = CallJoinBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId || call.state === 'ringing')
      return;
    if (!call.convId || call.convId !== parsed.data.convId || !this.o.mayJoin(call.convId, from))
      return;
    const entry = call.roster.get(from);
    if (entry && !entry.left) return;
    if (this.members(call).length + call.invited.size + 1 > MAX_CALL_PARTICIPANTS) {
      this.o.links.send(from, 'call.decline', { callId: call.callId, reason: 'full' });
      return;
    }
    this.sendInvite(call, from);
    this.changed();
  }

  private onReaction(from: string, raw: unknown): void {
    const parsed = CallReactionBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    if (!this.members(call).includes(from)) return;
    this.o.events.reaction(call.callId, from, parsed.data.emoji);
  }

  private onControl(from: string, raw: unknown): void {
    const parsed = CallControlBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    // Only the organiser's controls count.
    if (from !== call.organizer) return;
    const { action, target } = parsed.data;
    if (target && target !== this.o.selfId) return;
    if (action === 'mute') {
      this.update(call.callId, { muted: true });
      this.o.events.controlled(call.callId, 'mute');
    } else if (action === 'remove') {
      this.o.events.controlled(call.callId, 'remove');
      this.hangup(call.callId);
    }
  }

  // -------------------------------------------------------------------------

  private selfEntry(now: number, video: boolean): CallParticipant {
    return {
      userId: this.o.selfId,
      joinedAt: now,
      muted: false,
      video,
      sharing: false,
      onHold: false,
      lastSpokeAt: 0,
      left: false,
      v: 1,
    };
  }

  private require(callId: string): CallSession {
    const call = this.current;
    if (!call || call.callId !== callId) throw new Error('that call has ended');
    return call;
  }

  /** Participants who have not left, including this user. */
  members(call: CallSession): string[] {
    return [...call.roster.values()].filter((p) => !p.left).map((p) => p.userId);
  }

  private peersOf(call: CallSession): string[] {
    return [...call.roster.keys()].filter((u) => u !== this.o.selfId);
  }

  private sendInvite(call: CallSession, userId: string): void {
    call.invited.add(userId);
    call.declines.delete(userId);
    void this.o.connect(userId).then((ok) => {
      if (this.current !== call) return;
      const sent =
        ok &&
        this.o.links.send(userId, 'call.invite', {
          callId: call.callId,
          ...(call.convId && { convId: call.convId }),
          media: call.media,
          organizer: call.organizer,
          ...(call.open && { meeting: true }),
          participants: [...call.roster.values()].filter((p) => !p.left),
        });
      if (!sent) this.onUnreachable(call, userId);
    });
    this.clearInvite(userId);
    this.inviteTimers.set(
      userId,
      this.o.clock.setTimeout(() => {
        if (this.current !== call || !call.invited.has(userId)) return;
        call.invited.delete(userId);
        call.declines.set(userId, 'timeout');
        this.o.links.send(userId, 'call.hangup', { callId: call.callId });
        this.changed();
        this.afterLeave(call);
      }, CALL_RING_MS),
    );
  }

  /** An invitee whose PC cannot be reached counts as not answering. */
  private onUnreachable(call: CallSession, userId: string): void {
    if (!call.invited.has(userId)) return;
    this.clearInvite(userId);
    call.invited.delete(userId);
    call.declines.set(userId, 'timeout');
    this.changed();
    this.afterLeave(call);
  }

  private clearInvite(userId: string): void {
    const t = this.inviteTimers.get(userId);
    if (t) this.o.clock.clearTimeout(t);
    this.inviteTimers.delete(userId);
  }

  /** End the call once nobody else is in it or still being rung. */
  private afterLeave(call: CallSession): void {
    if (this.current !== call) return;
    // A meeting stays open while this user is in it, even alone.
    if (call.open) return;
    const others = this.members(call).filter((u) => u !== this.o.selfId);
    if (others.length > 0 || call.invited.size > 0) return;
    if (call.answeredAt !== undefined) {
      this.finish(call, 'completed');
      return;
    }
    // Nobody ever joined: say why, the most telling reason first.
    const reasons = new Set(call.declines.values());
    const outcome: CallOutcome = reasons.has('dnd')
      ? 'dnd'
      : reasons.has('busy')
        ? 'busy'
        : reasons.has('declined')
          ? 'declined'
          : 'no-answer';
    this.finish(call, outcome);
  }

  private finish(call: CallSession, outcome: CallOutcome): void {
    if (this.current !== call) return;
    this.stopRing();
    for (const u of [...this.inviteTimers.keys()]) this.clearInvite(u);
    this.current = undefined;
    this.o.repo.end(call.callId, this.o.clock.now(), outcome);
    this.o.events.ended(call, outcome);
    this.o.events.changed(null);
    this.o.events.historyChanged();
  }

  private stopRing(): void {
    if (this.ringTimer) this.o.clock.clearTimeout(this.ringTimer);
    this.ringTimer = undefined;
  }

  private stateBody(call: CallSession) {
    return {
      callId: call.callId,
      ...(call.convId && { convId: call.convId }),
      media: call.media,
      organizer: call.organizer,
      participants: [...call.roster.values()],
    };
  }

  private broadcastState(call: CallSession): void {
    const body = this.stateBody(call);
    for (const u of this.members(call)) if (u !== this.o.selfId) this.sendTo(u, 'call.state', body);
  }

  private sendTo(
    userId: string,
    type: 'call.sdp' | 'call.ice' | 'call.state',
    body: unknown,
  ): void {
    if (this.o.links.send(userId, type, body)) return;
    void this.o.connect(userId).then((ok) => {
      if (ok) this.o.links.send(userId, type, body);
    });
  }

  private changed(): void {
    this.o.events.changed(this.current ?? null);
  }
}

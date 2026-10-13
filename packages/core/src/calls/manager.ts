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
  MAX_RELAY_PARTICIPANTS,
  MAX_VIDEO_CALL_PARTICIPANTS,
  RELAY_CAPABLE_SCORE,
  RELAY_CAPPED_PARTICIPANTS,
  RELAY_HOST_TIMEOUT_MS,
  RELAY_NOTIFY_DATA,
  RelayNotifyBody,
  RelayRequestBody,
  RelayResponseBody,
  type CALL_REACTIONS,
  type CallDeclineReason,
  type CallMedia,
  type CallParticipant,
  type RelayMethod,
  type RelayNotifyMethod,
} from '@officemesh/protocol';
import type { CallHistoryItem, CallSignal } from '@officemesh/protocol/ipc';
import { signRecord, verifyRecord } from '../identity/crypto.ts';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';
import type { LinkManager } from '../link/link-manager.ts';
import type { RelayHost } from '../relay/host.ts';
import type { CallRepo } from '../store/calls.ts';
import type { z } from 'zod';

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
  /** A call from a group chat that left a card there, so members can join while it goes on. */
  announced?: boolean;
  /**
   * The temporary chat of a call that has grown to three or more people (made by the organiser's
   * PC and told to everyone in `call.state`). The call window shows it instead of `convId`.
   */
  chat?: string | undefined;
  /** On host relay (M6): who hosts the media, which hand-over this is, the size limit. */
  relay?: RelayState;
}

export interface RelayState {
  host: string;
  epoch: number;
  /** Joining the host (after an upgrade or a hand-over), not yet in. */
  reconnecting: boolean;
  /** Most people the meeting may hold with this host. */
  max: number;
  /** When the host last showed it was alive. */
  lastHeard: number;
  /** Hosts that failed during this call, never picked again. */
  failed: Set<string>;
}

export interface CallManagerEvents {
  /** The current call changed (null: there is none). */
  changed(call: CallSession | null, endedCallId?: string): void;
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
  controlled(callId: string, action: 'mute' | 'remove' | 'end'): void;
  /** From the relay host, for the media client: consumers, speakers, pauses. */
  relay(callId: string, epoch: number, method: RelayNotifyMethod, data: unknown): void;
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
  /** How well this PC can host a relay (0: it cannot), sent in its roster entry. */
  relayScore(): number;
  /** Start hosting the media relay for a call (mediasoup in this process). */
  startRelay?(call: CallSession, epoch: number): Promise<RelayHost>;
  /** Test builds: move to host relay above this many people instead of the mesh limits. */
  meshLimit?: number;
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
  /** The call this user is in (or placing, or being rung for when nothing else is going on). */
  private current: CallSession | undefined;
  /** A call ringing while the user is busy in `current`: answer it, add it or decline it. */
  private waiting: CallSession | undefined;
  /** Calls put on hold to take another one; they keep running, with this user flagged on hold. */
  private readonly held = new Map<string, CallSession>();
  private ringTimer: TimerHandle | undefined;
  private readonly inviteTimers = new Map<string, TimerHandle>();
  private lastSpoke = 0;
  /** The media relay this PC runs for the current call, if it is the host. */
  private host: RelayHost | undefined;
  private hostStarting: Promise<RelayHost | undefined> | undefined;
  private relayTimer: TimerHandle | undefined;
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
    links.on('relay.request', (from, body) => this.onRelayRequest(from, body));
    links.on('relay.notify', (from, body) => this.onRelayNotify(from, body));
    links.onLinkDown((userId) => this.onLinkDown(userId));
    options.repo.closeDangling(options.clock.now());
    this.relayTimer = options.clock.setInterval(() => this.checkRelay(), 1_000);
  }

  /** The relay this PC hosts for the current call, if any. */
  get relayHost(): RelayHost | undefined {
    return this.host;
  }

  get call(): CallSession | undefined {
    return this.current;
  }

  get inCall(): boolean {
    return (
      this.current?.state === 'active' || this.current?.state === 'outgoing' || this.held.size > 0
    );
  }

  /** Every call this PC knows about: the current one, the one waiting, and those on hold. */
  get calls(): CallSession[] {
    return [this.current, this.waiting, ...this.held.values()].filter(
      (c): c is CallSession => c !== undefined,
    );
  }

  isWaiting(call: CallSession): boolean {
    return this.waiting === call;
  }

  isHeld(call: CallSession): boolean {
    return this.held.get(call.callId) === call;
  }

  /** The call with this id wherever it is kept. */
  private lookup(callId: string): CallSession | undefined {
    if (this.current?.callId === callId) return this.current;
    if (this.waiting?.callId === callId) return this.waiting;
    return this.held.get(callId);
  }

  private alive(call: CallSession): boolean {
    return this.current === call || this.waiting === call || this.held.get(call.callId) === call;
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
      invitees.length + 1 > MAX_VIDEO_CALL_PARTICIPANTS && !input.open ? 'audio' : input.media;
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
    if (!call.relay && present + fresh.length > this.meshLimit(call) && !this.upgradeToRelay(call))
      throw new Error(`a call can have at most ${this.meshLimit(call)} people here`);
    if (call.relay && present + fresh.length > call.relay.max)
      throw new Error(`this meeting can have at most ${call.relay.max} people`);
    for (const u of fresh) this.sendInvite(call, u);
    this.o.repo.setPeers(call.callId, [...new Set([...this.peersOf(call), ...fresh])]);
    this.changed();
    return call;
  }

  /**
   * Answer a ringing call. When another call is going on, `how` says what happens to it:
   * `hold` puts it on hold (it keeps running; `resume` brings it back) and `end` hangs up.
   */
  accept(callId: string, video: boolean, how?: 'hold' | 'end'): CallSession {
    const call = this.require(callId);
    if (call.state !== 'ringing') throw new Error('this call is not ringing');
    if (this.waiting === call) {
      const busy = this.current;
      if (busy) {
        if (how === 'end') this.hangup(busy.callId);
        else if (how === 'hold') this.park(busy);
        else throw new Error('choose what happens to the call you are in');
      }
      this.waiting = undefined;
      this.current = call;
    }
    this.stopRing();
    const now = this.o.clock.now();
    call.state = 'active';
    call.answeredAt = now;
    const self = this.selfEntry(now, video && call.media === 'video');
    call.roster.set(this.o.selfId, self);
    this.o.repo.answered(call.callId, now);
    this.o.links.send(call.caller, 'call.accept', { callId, participant: self });
    if (call.relay) void this.relayJoin(call);
    else this.broadcastState(call);
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
    const call = this.lookup(callId);
    if (!call) return;
    if (call.state === 'ringing') {
      this.decline(callId);
      return;
    }
    if (call.relay) {
      // Tell the host (or, hosting, tell everyone this host is leaving: they hand over).
      if (call.relay.host === this.o.selfId) this.host?.leave(this.o.selfId);
      else void this.relaySend(call, 'leave', {}).catch(() => {});
      for (const u of call.invited) this.o.links.send(u, 'call.hangup', { callId });
    } else {
      for (const u of [...this.members(call), ...call.invited]) {
        if (u !== this.o.selfId) this.o.links.send(u, 'call.hangup', { callId });
      }
    }
    this.finish(call, call.answeredAt !== undefined ? 'completed' : 'cancelled');
  }

  /** Put a call on hold so another can be taken: it stays alive, and colleagues see "on hold". */
  private park(call: CallSession): void {
    if (call.relay) throw new Error('a large meeting cannot be put on hold');
    this.update(call.callId, { onHold: true });
    this.held.set(call.callId, call);
    if (this.current === call) this.current = undefined;
  }

  /** Put the current call on hold, if any, and take this held one off hold. */
  resume(callId: string): CallSession {
    const call = this.held.get(callId);
    if (!call) throw new Error('that call is not on hold');
    if (this.current) this.park(this.current);
    this.held.delete(callId);
    this.current = call;
    this.update(callId, { onHold: false });
    this.changed();
    return call;
  }

  /**
   * Add the caller of the waiting call to the call this user is in: the waiting call is
   * declined, then its caller is invited into the current one.
   */
  merge(callId: string): CallSession {
    const waiting = this.waiting;
    const into = this.current;
    if (!waiting || waiting.callId !== callId) throw new Error('that call is not waiting');
    if (!into || into.state === 'ringing') throw new Error('there is no call to add it to');
    const caller = waiting.caller;
    this.o.links.send(caller, 'call.decline', { callId, reason: 'declined' });
    this.finish(waiting, 'declined');
    return this.invite(into.callId, [caller]);
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
      // On relay the host hears who speaks; in a mesh, starts are gossiped once a second.
      if (call.relay) return;
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
    this.publishSelf(call);
    this.changed();
  }

  /** Our own entry changed: to the host on relay, to everyone in a mesh. */
  private publishSelf(call: CallSession): void {
    if (!call.relay) {
      this.broadcastState(call);
      return;
    }
    if (call.relay.reconnecting) return; // the join carries the newest entry
    const participant = call.roster.get(this.o.selfId)!;
    void this.relaySend(call, 'update', { participant }).catch(() => {});
  }

  /** The renderer lost the media connection to a participant: drop them for everyone. */
  dropped(callId: string, userId: string): void {
    const call = this.require(callId);
    // On relay the host decides who is in; media to the host is watched separately.
    if (call.relay) return;
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
    if (call.relay) {
      // The host passes it to everyone, this user included.
      void this.relaySend(call, 'react', { emoji }).catch(() => {});
      return;
    }
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
    if (call.relay) {
      void this.relaySend(call, 'control', { action, target }).catch((err: unknown) =>
        this.o.logger.warn('relay control failed', { err: String(err) }),
      );
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

  /**
   * Only the organiser: the call ends for every participant. Others have "leave" (`hangup`),
   * which only takes this person out. Older builds ignore the `end` control and stay in until
   * the hang-up that follows it tells them the organiser has gone.
   */
  endForAll(callId: string): void {
    const call = this.require(callId);
    if (call.organizer !== this.o.selfId)
      throw new Error('only the organiser can end the call for everyone');
    if (call.state === 'ringing') throw new Error('answer the call first');
    if (call.relay) {
      void this.relaySend(call, 'control', { action: 'end', target: null })
        .catch((err: unknown) =>
          this.o.logger.warn('relay end for everyone failed', { err: String(err) }),
        )
        .finally(() => {
          if (this.alive(call)) this.hangup(callId);
        });
      for (const u of call.invited) this.o.links.send(u, 'call.hangup', { callId });
      return;
    }
    for (const u of [...this.members(call), ...call.invited]) {
      if (u !== this.o.selfId)
        this.o.links.send(u, 'call.control', { callId, action: 'end', target: u });
    }
    this.hangup(callId);
  }

  /** The temporary chat of this call exists (made by this PC, as organiser): tell everyone. */
  setChat(callId: string, convId: string): void {
    const call = this.lookup(callId);
    if (!call || call.relay || call.chat === convId) return;
    call.chat = convId;
    this.broadcastState(call);
    this.changed();
  }

  stop(): void {
    if (this.relayTimer) this.o.clock.clearInterval(this.relayTimer);
    for (const j of this.joining.values()) this.o.clock.clearTimeout(j.timer);
    this.joining.clear();
    for (const call of this.calls) this.hangup(call.callId);
    this.stopRing();
    for (const t of this.inviteTimers.values()) this.o.clock.clearTimeout(t);
    this.inviteTimers.clear();
    this.closeHost();
  }

  // -------------------------------------------------------------------------
  // Messages from colleagues
  // -------------------------------------------------------------------------

  private onInvite(from: string, raw: unknown): void {
    const parsed = CallInviteBody.safeParse(raw);
    if (!parsed.success) return;
    const body = parsed.data;
    const now = this.o.clock.now();
    const existing = this.lookup(body.callId);
    if (existing && existing === this.waiting) return;
    if (existing) {
      // The same meeting started twice (two people pressed Join at once): merge into one.
      const call = existing;
      if (call.state === 'ringing' || call.relay || body.relay) return;
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
      ...(body.chat && { chat: body.chat }),
      open: this.joining.has(body.callId) || body.meeting === true,
      ...(body.relay && {
        relay: {
          host: body.relay.host,
          epoch: body.relay.epoch,
          reconnecting: true,
          max: MAX_RELAY_PARTICIPANTS,
          lastHeard: now,
          failed: new Set<string>(),
        },
      }),
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
    // Already in a call: ring as a waiting call, unless one is already waiting (or the user
    // has not even answered the first yet), and Do not disturb still wins.
    const canWait =
      this.current !== undefined && this.current.state !== 'ringing' && this.waiting === undefined;
    const auto: CallDeclineReason | null = this.o.doNotDisturb()
      ? 'dnd'
      : this.current && !canWait
        ? 'busy'
        : !call.relay && call.roster.size + 1 > MAX_CALL_PARTICIPANTS
          ? 'full'
          : null;
    if (auto) {
      this.o.links.send(from, 'call.decline', { callId: body.callId, reason: auto });
      this.o.repo.end(call.callId, now, auto === 'full' ? 'declined' : auto);
      if (auto !== 'full') this.o.events.missed(call, auto);
      this.o.events.historyChanged();
      return;
    }
    if (canWait) this.waiting = call;
    else this.current = call;
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
      if (!this.alive(call) || call.state !== 'ringing') return;
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
    const call = parsed.success ? this.lookup(parsed.data.callId) : undefined;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    if (!call.invited.has(from) || parsed.data.participant.userId !== from) return;
    this.clearInvite(from);
    call.invited.delete(from);
    if (call.relay) {
      // They join through the host, which tells everyone.
      this.changed();
      return;
    }
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
    // Asked to join a meeting that is full: say so now rather than waiting to time out.
    const joining = parsed.success ? this.joining.get(parsed.data.callId) : undefined;
    if (joining && parsed.data?.reason === 'full') {
      this.joining.delete(parsed.data.callId);
      this.o.clock.clearTimeout(joining.timer);
      joining.reject(
        new Error(
          'This meeting is full: it has as many people as the PCs in it can carry (25 without a PC on wired gigabit Ethernet with 8 or more cores).',
        ),
      );
      return;
    }
    const call = parsed.success ? this.lookup(parsed.data.callId) : undefined;
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
    const call = parsed.success ? this.lookup(parsed.data.callId) : undefined;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    if (call.state === 'ringing') {
      if (from !== call.caller) return;
      this.o.events.missed(call, null);
      this.finish(call, 'missed');
      return;
    }
    if (call.relay) return;
    const entry = call.roster.get(from);
    if (!entry || entry.left) return;
    call.roster.set(from, { ...entry, left: true, v: entry.v + 1 });
    this.changed();
    this.afterLeave(call);
  }

  private onState(from: string, raw: unknown): void {
    const parsed = CallStateBody.safeParse(raw);
    const call = parsed.success ? this.lookup(parsed.data.callId) : undefined;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    if (call.state === 'ringing') return;
    if (!call.roster.has(from) && !call.invited.has(from) && from !== call.caller) return;
    if (call.relay) return;
    if (parsed.data.relay) {
      // The meeting outgrew the mesh: move to the host relay with everyone else.
      this.adoptRelay(call, parsed.data.relay.host, parsed.data.relay.epoch);
      return;
    }
    let changed = false;
    if (parsed.data.chat && call.chat !== parsed.data.chat) {
      call.chat = parsed.data.chat;
      changed = true;
    }
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
    const call = parsed.success ? this.lookup(parsed.data.callId) : undefined;
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
    const call = parsed.success ? this.lookup(parsed.data.callId) : undefined;
    if (!parsed.success || !call || call.callId !== parsed.data.callId || call.state === 'ringing')
      return;
    this.o.events.signal(call.callId, from, { kind: 'ice', candidate: parsed.data.candidate });
  }

  /** A colleague asks to join the meeting we are in: invite them if they belong to its chat. */
  private onJoin(from: string, raw: unknown): void {
    const parsed = CallJoinBody.safeParse(raw);
    const call = parsed.success ? this.lookup(parsed.data.callId) : undefined;
    if (!parsed.success || !call || call.callId !== parsed.data.callId || call.state === 'ringing')
      return;
    if (!call.convId || call.convId !== parsed.data.convId || !this.o.mayJoin(call.convId, from))
      return;
    const entry = call.roster.get(from);
    if (entry && !entry.left) return;
    const wanted = this.members(call).length + call.invited.size + 1;
    const fits = call.relay
      ? wanted <= call.relay.max
      : wanted <= this.meshLimit(call) || this.upgradeToRelay(call);
    if (!fits) {
      this.o.links.send(from, 'call.decline', { callId: call.callId, reason: 'full' });
      return;
    }
    this.sendInvite(call, from);
    this.changed();
  }

  private onReaction(from: string, raw: unknown): void {
    const parsed = CallReactionBody.safeParse(raw);
    const call = parsed.success ? this.lookup(parsed.data.callId) : undefined;
    if (!parsed.success || !call || call.callId !== parsed.data.callId) return;
    if (!this.members(call).includes(from)) return;
    this.o.events.reaction(call.callId, from, parsed.data.emoji);
  }

  private onControl(from: string, raw: unknown): void {
    const parsed = CallControlBody.safeParse(raw);
    const call = parsed.success ? this.lookup(parsed.data.callId) : undefined;
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
    } else if (action === 'end') {
      // Over for everyone: no hang-ups to each other, the organiser told them all.
      this.o.events.controlled(call.callId, 'end');
      if (call.state === 'ringing') {
        this.o.events.missed(call, null);
        this.finish(call, 'missed');
      } else {
        this.finish(call, call.answeredAt !== undefined ? 'completed' : 'cancelled');
      }
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
      relay: this.o.relayScore(),
    };
  }

  private require(callId: string): CallSession {
    const call = this.lookup(callId);
    if (!call) throw new Error('that call has ended');
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
      if (!this.alive(call)) return;
      const sent =
        ok &&
        this.o.links.send(userId, 'call.invite', {
          callId: call.callId,
          ...(call.convId && { convId: call.convId }),
          media: call.media,
          organizer: call.organizer,
          ...(call.chat && { chat: call.chat }),
          ...(call.open && { meeting: true }),
          // On relay the host sends the full roster; the invitation carries only the host.
          participants: call.relay
            ? []
            : [...call.roster.values()].filter((p) => !p.left).slice(0, MAX_CALL_PARTICIPANTS),
          ...(call.relay && { relay: { host: call.relay.host, epoch: call.relay.epoch } }),
        });
      if (!sent) this.onUnreachable(call, userId);
    });
    this.clearInvite(userId);
    this.inviteTimers.set(
      userId,
      this.o.clock.setTimeout(() => {
        if (!this.alive(call) || !call.invited.has(userId)) return;
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

  /**
   * The organiser left while others are still in: the person who has been in the longest is the
   * organiser now (ties by user id). Every PC works it out the same way from the same roster, so
   * no message is needed. A host relay keeps its own hand-over.
   */
  private reassignOrganizer(call: CallSession): void {
    if (call.relay) return;
    const here = this.members(call);
    if (here.length === 0 || here.includes(call.organizer)) return;
    const next = [...here].sort((a, b) => {
      const d = (call.roster.get(a)?.joinedAt ?? 0) - (call.roster.get(b)?.joinedAt ?? 0);
      return d !== 0 ? d : a < b ? -1 : 1;
    })[0]!;
    call.organizer = next;
    this.changed();
  }

  /** End the call once nobody else is in it or still being rung. */
  private afterLeave(call: CallSession): void {
    if (!this.alive(call)) return;
    this.reassignOrganizer(call);
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
    if (!this.alive(call)) return;
    const wasCurrent = this.current === call;
    // The ring timer belongs to whichever call is ringing (the current one, or the waiting one).
    if (this.waiting === call || (wasCurrent && call.state === 'ringing')) this.stopRing();
    // Invitations are sent for the call being built up: the current one (or one on hold).
    for (const u of [...this.inviteTimers.keys()]) if (wasCurrent) this.clearInvite(u);
    if (wasCurrent) this.current = undefined;
    if (this.waiting === call) this.waiting = undefined;
    this.held.delete(call.callId);
    if (wasCurrent) this.closeHost();
    this.o.repo.end(call.callId, this.o.clock.now(), outcome);
    this.o.events.ended(call, outcome);
    this.o.events.changed(null, call.callId);
    if (this.calls.length > 0) this.changed();
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
      ...(call.chat && { chat: call.chat }),
      participants: [...call.roster.values()].slice(0, MAX_CALL_PARTICIPANTS),
      ...(call.relay && { relay: { host: call.relay.host, epoch: call.relay.epoch } }),
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

  /** Tell the UI about every call that exists (each window follows its own). */
  private changed(): void {
    const calls = this.calls;
    if (calls.length === 0) this.o.events.changed(null);
    for (const call of calls) this.o.events.changed(call);
  }

  // -------------------------------------------------------------------------
  // Host relay (M6)
  // -------------------------------------------------------------------------

  /** People a mesh call may hold before it moves to the relay. */
  private meshLimit(call: CallSession): number {
    if (this.o.meshLimit !== undefined) return this.o.meshLimit;
    return call.media === 'video' ? MAX_VIDEO_CALL_PARTICIPANTS : MAX_CALL_PARTICIPANTS;
  }

  private scoreOf(call: CallSession, userId: string): number {
    if (userId === this.o.selfId) return this.o.relayScore();
    return call.roster.get(userId)?.relay ?? 0;
  }

  /**
   * Who hosts: the organiser if its PC is relay-capable, otherwise the strongest PC that
   * can host at all (ties: lowest userId). Everyone computes the same answer from the
   * same roster, so a hand-over needs no election.
   */
  private pickHost(
    call: CallSession,
    exclude: Set<string>,
  ): { userId: string; score: number } | undefined {
    const candidates = this.members(call)
      .filter((u) => !exclude.has(u))
      .map((u) => ({ userId: u, score: this.scoreOf(call, u) }))
      .filter((c) => c.score > 0);
    const organizer = candidates.find((c) => c.userId === call.organizer);
    if (organizer && organizer.score >= RELAY_CAPABLE_SCORE) return organizer;
    candidates.sort((a, b) => b.score - a.score || (a.userId < b.userId ? -1 : 1));
    return candidates[0];
  }

  private maxFor(score: number): number {
    return score >= RELAY_CAPABLE_SCORE ? MAX_RELAY_PARTICIPANTS : RELAY_CAPPED_PARTICIPANTS;
  }

  /**
   * The meeting outgrew the mesh: if every participant can use a relay and one PC can
   * host it, move everyone there. False if it cannot (the newcomer is then declined).
   */
  private upgradeToRelay(call: CallSession): boolean {
    if (call.relay || !this.o.startRelay) return false;
    const others = this.members(call).filter((u) => u !== this.o.selfId);
    if (!others.every((u) => this.o.links.hasCap(u, 'calls.relay'))) return false;
    const host = this.pickHost(call, new Set());
    if (!host) return false;
    this.o.logger.info('meeting moves to host relay', { callId: call.callId, host: host.userId });
    this.adoptRelay(call, host.userId, 1);
    this.broadcastState(call);
    return true;
  }

  /** Switch the current call to relay with this host and epoch, and join it. */
  private adoptRelay(
    call: CallSession,
    host: string,
    epoch: number,
    keepFailed?: Set<string>,
  ): void {
    const failed = keepFailed ?? call.relay?.failed ?? new Set<string>();
    if (
      call.relay &&
      (call.relay.epoch > epoch || (call.relay.epoch === epoch && call.relay.host === host))
    )
      return;
    if (this.host && (host !== this.o.selfId || this.host.epoch !== epoch)) this.closeHost();
    call.relay = {
      host,
      epoch,
      reconnecting: true,
      max: this.maxFor(this.scoreOf(call, host)),
      lastHeard: this.o.clock.now(),
      failed,
    };
    this.changed();
    if (call.state === 'ringing') return;
    if (host === this.o.selfId) void this.becomeHost(call, epoch);
    else void this.relayJoin(call);
  }

  /** Start this PC's relay for the call and take its own place in it. */
  private async becomeHost(call: CallSession, epoch: number): Promise<RelayHost | undefined> {
    if (this.host?.epoch === epoch) return this.host;
    if (this.hostStarting) return this.hostStarting;
    const start = this.o.startRelay;
    if (!start) return undefined;
    this.hostStarting = (async () => {
      try {
        const host = await start(call, epoch);
        if (
          this.current !== call ||
          call.relay?.host !== this.o.selfId ||
          call.relay.epoch !== epoch
        ) {
          host.close();
          return undefined;
        }
        this.host = host;
        host.organizer = call.organizer;
        // Everyone in the call so far is expected back (a hand-over) or about to join.
        host.seed(
          [...call.roster.values()].filter((p) => !call.relay!.failed.has(p.userId)),
          this.o.clock.now(),
        );
        const joined = (await host.handle(this.o.selfId, 'join', {
          participant: call.roster.get(this.o.selfId),
        })) as { participants: CallParticipant[] };
        this.applyRoster(call, joined.participants, true);
        call.relay.reconnecting = false;
        call.relay.lastHeard = this.o.clock.now();
        this.changed();
        return host;
      } catch (err) {
        this.o.logger.error('could not start the relay', { err: String(err) });
        if (this.current === call && call.relay?.host === this.o.selfId)
          this.hostFailed(call, this.o.selfId);
        return undefined;
      } finally {
        this.hostStarting = undefined;
      }
    })();
    return this.hostStarting;
  }

  private closeHost(): void {
    this.host?.close();
    this.host = undefined;
  }

  /** Join (or rejoin) the relay host; on failure, hand over to the next host. */
  private async relayJoin(call: CallSession): Promise<void> {
    const relay = call.relay;
    if (!relay || relay.host === this.o.selfId) return;
    const { host, epoch } = relay;
    relay.reconnecting = true;
    // Long enough to ride out a busy host, short enough for a hand-over within seconds.
    const deadline = this.o.clock.now() + 3_000;
    while (
      this.current === call &&
      call.relay === relay &&
      relay.host === host &&
      relay.epoch === epoch
    ) {
      try {
        if (!(await this.o.connect(host))) throw new Error('host unreachable');
        const reply = await this.o.links.request(
          host,
          'relay.request',
          {
            callId: call.callId,
            epoch,
            method: 'join',
            data: { participant: call.roster.get(this.o.selfId) },
          },
          4_000,
        );
        const body = RelayResponseBody.parse(reply.body);
        if (body.redirect) {
          // Back to a host we gave up on too soon (it is alive): its epoch may be lower.
          relay.failed.delete(body.redirect.host);
          if (call.relay === relay) delete call.relay;
          this.adoptRelay(call, body.redirect.host, body.redirect.epoch, relay.failed);
          return;
        }
        if (!body.ok) {
          if (body.error === 'full' || body.error?.startsWith('not invited')) {
            this.finish(call, 'completed');
            return;
          }
          throw new Error(body.error ?? 'join refused');
        }
        const joined = body.data as {
          participants: CallParticipant[];
          organizer?: string;
          max?: number;
        };
        if (call.relay !== relay) return;
        if (joined.organizer) call.organizer = joined.organizer;
        if (joined.max) relay.max = joined.max;
        this.applyRoster(call, joined.participants, true);
        relay.reconnecting = false;
        relay.lastHeard = this.o.clock.now();
        this.changed();
        return;
      } catch (err) {
        if (this.o.clock.now() >= deadline) {
          this.o.logger.warn('relay host did not answer', { host, err: String(err) });
          if (this.current === call && call.relay === relay) this.hostFailed(call, host);
          return;
        }
        await new Promise<void>((r) => this.o.clock.setTimeout(r, 500));
      }
    }
  }

  /** The host is gone: the next strongest participant takes over (plan section 9). */
  private hostFailed(call: CallSession, failedHost: string): void {
    const relay = call.relay;
    if (!relay || relay.host !== failedHost) return;
    relay.failed.add(failedHost);
    const entry = call.roster.get(failedHost);
    if (entry && !entry.left && failedHost !== this.o.selfId)
      call.roster.set(failedHost, { ...entry, left: true, v: entry.v + 1 });
    const next = this.pickHost(call, relay.failed);
    if (!next) {
      this.o.logger.warn('no PC left that can host the meeting', { callId: call.callId });
      this.finish(call, 'completed');
      return;
    }
    this.o.logger.info('relay hand-over', {
      from: failedHost,
      to: next.userId,
      epoch: relay.epoch + 1,
    });
    this.adoptRelay(call, next.userId, relay.epoch + 1);
  }

  private onLinkDown(userId: string): void {
    const call = this.current;
    if (!call?.relay || call.relay.host !== userId || call.relay.reconnecting) return;
    // A host that quit refuses the reconnect at once; one that only blipped answers.
    void this.o.connect(userId).then((ok) => {
      if (this.current !== call || call.relay?.host !== userId) return;
      if (ok) void this.relayJoin(call);
      else this.hostFailed(call, userId);
    });
  }

  /** Every second: a host silent for 6 s counts as gone (power cut, pulled cable). */
  private checkRelay(): void {
    const call = this.current;
    const relay = call?.relay;
    if (!call || !relay || relay.host === this.o.selfId || relay.reconnecting) return;
    if (this.o.clock.now() - relay.lastHeard > RELAY_HOST_TIMEOUT_MS)
      this.hostFailed(call, relay.host);
  }

  private applyRoster(call: CallSession, entries: CallParticipant[], full: boolean): void {
    const seen = new Set<string>();
    for (const p of entries) {
      seen.add(p.userId);
      if (p.userId === this.o.selfId) {
        if (p.left && !full) {
          // The host dropped us (the organiser removed us, or it lost us).
          this.finish(call, 'completed');
          return;
        }
        continue;
      }
      const mine = call.roster.get(p.userId);
      if (mine && mine.v > p.v) continue;
      call.roster.set(p.userId, p);
      call.invited.delete(p.userId);
    }
    // A snapshot (`full`) only adds and updates: a notice that someone joined can overtake
    // it, so absence from it proves nothing. The host announces departures itself, with
    // a higher version (including people who did not come back after a hand-over).
    void full;
    // The host itself left the meeting: hand over now rather than after the timeout.
    const host = call.relay?.host;
    if (host && host !== this.o.selfId && call.roster.get(host)?.left) {
      this.hostFailed(call, host);
      return;
    }
    if (call.state === 'outgoing' && this.members(call).length > 1) {
      call.state = 'active';
      call.answeredAt = this.o.clock.now();
      this.o.repo.answered(call.callId, call.answeredAt);
    }
    this.o.repo.setPeers(call.callId, this.peersOf(call));
  }

  /** A request to the relay host: over the link, or to this PC's own relay. */
  async relaySend(call: CallSession, method: RelayMethod, data: unknown): Promise<unknown> {
    const relay = call.relay;
    if (!relay) throw new Error('this call is not on a relay');
    if (relay.host === this.o.selfId) {
      const host = this.host ?? (await this.hostStarting);
      if (!host) throw new Error('the relay is starting');
      return host.handle(this.o.selfId, method, data);
    }
    const reply = await this.o.links.request(
      relay.host,
      'relay.request',
      { callId: call.callId, epoch: relay.epoch, method, data },
      10_000,
    );
    const body = RelayResponseBody.parse(reply.body);
    if (!body.ok) throw new Error(body.error ?? 'the relay refused');
    return body.data;
  }

  /** A media request from this PC's renderer (or a simulated participant). */
  async relayRequest(
    callId: string,
    epoch: number,
    method: RelayMethod,
    data: unknown,
  ): Promise<unknown> {
    const call = this.require(callId);
    if (!call.relay || call.relay.epoch !== epoch)
      throw new Error('the relay changed; reconnecting');
    return this.relaySend(call, method, data);
  }

  /** Requests to the relay this PC hosts. */
  private async onRelayRequest(from: string, raw: unknown) {
    const reply = (body: z.infer<typeof RelayResponseBody>) => ({ type: 'relay.response', body });
    const parsed = RelayRequestBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call || call.callId !== parsed.data.callId || call.state === 'ringing')
      return reply({ ok: false, error: 'no such meeting here' });
    const { method, epoch, data } = parsed.data;
    let host = this.host;
    if (!host && method === 'join' && call.relay && call.relay.host === this.o.selfId)
      host = await this.hostStarting;
    // The asker thinks the host is gone, but this PC still hears it: send them back.
    const alive =
      call.relay &&
      call.relay.host !== this.o.selfId &&
      !call.relay.reconnecting &&
      this.o.links.isReady(call.relay.host) &&
      this.o.clock.now() - call.relay.lastHeard < RELAY_HOST_TIMEOUT_MS / 2;
    if (!host && alive && call.relay) {
      return reply({
        ok: false,
        error: 'the host is still there',
        redirect: { host: call.relay.host, epoch: call.relay.epoch },
      });
    }
    // A hand-over picked this PC before it noticed the old host was gone.
    if (!host && method === 'join' && epoch > (call.relay?.epoch ?? 0) && this.o.relayScore() > 0) {
      if (!call.roster.has(from) && !call.invited.has(from))
        return reply({ ok: false, error: 'not invited' });
      if (call.relay) call.relay.failed.add(call.relay.host);
      this.adoptRelay(call, this.o.selfId, epoch);
      host = await this.becomeHost(call, epoch);
    }
    if (!host) {
      return reply({
        ok: false,
        error: 'not the host',
        ...(call.relay && { redirect: { host: call.relay.host, epoch: call.relay.epoch } }),
      });
    }
    try {
      return reply({ ok: true, data: await host.handle(from, method, data) });
    } catch (err) {
      return reply({
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 300) : 'failed',
      });
    }
  }

  /** May this colleague join the relay this PC hosts? */
  mayJoinRelay(userId: string): boolean {
    const call = this.current;
    if (!call) return false;
    if (call.roster.has(userId) || call.invited.has(userId)) return true;
    return call.convId !== undefined && this.o.mayJoin(call.convId, userId);
  }

  /** Notifications from the relay host (or this PC's own relay, delivered locally). */
  deliverRelayNotify(from: string, raw: unknown): void {
    this.onRelayNotify(from, raw);
  }

  private onRelayNotify(from: string, raw: unknown): void {
    const parsed = RelayNotifyBody.safeParse(raw);
    const call = this.current;
    if (!parsed.success || !call?.relay || call.callId !== parsed.data.callId) return;
    const relay = call.relay;
    if (from !== relay.host) return;
    const { method, epoch } = parsed.data;
    if (method === 'batch') {
      const batch = RELAY_NOTIFY_DATA.batch.safeParse(parsed.data.data);
      if (!batch.success) return;
      for (const item of batch.data.items) {
        if (item.method === 'batch') continue;
        this.onRelayNotify(from, {
          callId: call.callId,
          epoch,
          method: item.method,
          data: item.data,
        });
      }
      return;
    }
    const data = RELAY_NOTIFY_DATA[method].safeParse(parsed.data.data);
    if (!data.success) return;
    relay.lastHeard = this.o.clock.now();
    if (epoch > relay.epoch) relay.epoch = epoch;
    switch (method) {
      case 'roster': {
        const body = data.data as z.infer<(typeof RELAY_NOTIFY_DATA)['roster']>;
        if (body.organizer) call.organizer = body.organizer;
        this.applyRoster(call, body.participants, body.full === true);
        if (this.current === call) this.changed();
        return;
      }
      case 'heartbeat':
        break;
      case 'reaction': {
        const body = data.data as { userId: string; emoji: (typeof CALL_REACTIONS)[number] };
        this.o.events.reaction(call.callId, body.userId, body.emoji);
        return;
      }
      case 'controlled': {
        const { action } = data.data as { action: 'mute' | 'remove' | 'end' };
        if (action === 'mute') {
          this.update(call.callId, { muted: true });
          this.o.events.controlled(call.callId, 'mute');
        } else {
          this.o.events.controlled(call.callId, action === 'end' ? 'end' : 'remove');
          this.finish(call, 'completed');
        }
        return;
      }
    }
    this.o.events.relay(call.callId, relay.epoch, method, data.data);
  }
}

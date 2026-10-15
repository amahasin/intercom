import { randomBytes } from 'node:crypto';
import {
  AssistDeclineBody,
  AssistEndBody,
  AssistIdBody,
  AssistRequestBody,
  AssistScreenBody,
  AssistTicketBody,
  type AssistKind,
  type AssistScreen,
} from '@officemesh/protocol';
import type { AssistStatus, AssistView } from '@officemesh/protocol/ipc';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';
import type { LinkManager } from '../link/link-manager.ts';

/** Why a session's window or process ended on this PC without InterCom asking it to. */
export type AssistExit =
  /** The person here ended it (End session, or closed the window). */
  | 'closed'
  /** The colleague's side ended it. */
  | 'peer-left'
  /** The connection never came up (nobody connected, or the viewer could not reach this PC). */
  | 'no-connection'
  /** It stopped working. */
  | 'failed';

/**
 * What the host does for remote help: it runs the sharing and viewing of a desktop through the
 * Windows Remote Desktop Services session sharing API, in a small helper program of its own.
 * Every call names the session it is for.
 */
export interface RemoteAssistHost {
  /** Whether this PC can do remote help at all (`available`); `allowed` is Windows' Remote Assistance setting. */
  status(): Promise<AssistStatus>;
  /**
   * Start sharing this desktop. Resolves with what the colleague needs to connect: the
   * connection string, a password made for this session alone (never shown to anyone), and this
   * PC's screens. A window stays on this desktop until the session ends.
   */
  share(
    sessionId: string,
    peerName: string,
  ): Promise<{ ticket: string; password: string; screens: AssistScreen[] }>;
  /** Show the colleague's desktop in a window of its own. */
  view(
    sessionId: string,
    connect: {
      ticket: string;
      password: string;
      screens: AssistScreen[];
      peerName: string;
      selfName: string;
    },
  ): Promise<void>;
  /** Sharing side: show this screen only (`index`), or all of them (-1). */
  selectScreen(sessionId: string, index: number): void;
  /** Sharing side: let the colleague control this PC, or only look. */
  setControl(sessionId: string, on: boolean): void;
  /** Control was switched on or off (the sharing helper reports it, from its own menu too). */
  onControl(listener: (sessionId: string, on: boolean) => void): void;
  /** End that session's helper, if it is running. */
  stop(sessionId: string): void;
  /** A session ended on this PC by itself (see `AssistExit`). */
  onExit(listener: (sessionId: string, reason: AssistExit) => void): void;
  /** Viewing side: the person chose a screen in the viewer window. */
  onScreen(listener: (sessionId: string, index: number) => void): void;
  /** Viewing side: the person asked for the conversation with the colleague. */
  onChat(listener: (sessionId: string) => void): void;
  /** Windows' Remote settings (where Remote Assistance is turned on). */
  openSettings(): void;
}

export interface AssistManagerOptions {
  selfId: string;
  links: LinkManager;
  connect: (userId: string) => Promise<boolean>;
  host: RemoteAssistHost | undefined;
  clock: Clock;
  logger: Logger;
  /** The sessions changed (all of them). */
  changed: (sessions: AssistView[]) => void;
  /** A colleague asks this user: tell them (a toast) unless the app is in front. */
  asked: (session: AssistView) => void;
  /** How people are named in the sharing and viewing windows. */
  nameOf: (userId: string) => string;
  selfName: () => string;
  /** Show the conversation with a colleague (from the viewer window's "Conversation"). */
  openChat: (userId: string) => void;
}

/** How long a request waits for an answer. */
export const ASSIST_ANSWER_MS = 60_000;
/** How long, once accepted, before the connection details must have arrived. */
export const ASSIST_TICKET_MS = 45_000;
/** Ended sessions are forgotten after this (or when dismissed). */
const ENDED_KEPT_MS = 10 * 60_000;
/** The connection string of a sharing session is XML starting with this element. */
const CONNECTION_STRING = /^\s*<E[\s>]/;

type Reason = NonNullable<AssistView['endReason']>;

interface Session extends AssistView {
  timer?: TimerHandle;
  /** The sharing side's screens (to check a colleague's choice against). */
  screenCount?: number;
}

/**
 * Remote help between two colleagues. One asks (to be helped, or to help); the other answers in
 * InterCom, which is the permission: nothing starts before it. Then the PC whose desktop is shown
 * starts a sharing session, and sends its connection string and a password made for this session
 * to the other over the encrypted peer link (never into a chat; nobody types or sees the
 * password). The other PC connects and shows the desktop in a window of its own, and picks a
 * screen there. The person sharing has a window on their desktop for as long as it lasts, with
 * "Stop control" and "End session". Either side can end it from InterCom or from its window.
 * One session at a time.
 */
export class AssistManager {
  private readonly o: AssistManagerOptions;
  private readonly sessions = new Map<string, Session>();

  constructor(options: AssistManagerOptions) {
    this.o = options;
    const { links } = options;
    links.on('assist.request', (from, body) => this.onRequest(from, body));
    links.on('assist.accept', (from, body) => void this.onAccept(from, body));
    links.on('assist.decline', (from, body) => this.onDecline(from, body));
    links.on('assist.ticket', (from, body) => void this.onTicket(from, body));
    links.on('assist.screen', (from, body) => this.onScreen(from, body));
    links.on('assist.end', (from, body) => this.onEnd(from, body));
    links.onLinkDown((userId) => {
      for (const s of this.sessions.values())
        if (s.peer === userId && s.state !== 'ended') this.finish(s, 'lost', 'peer');
    });
    const host = options.host;
    host?.onExit((sessionId, reason) => this.onHostExit(sessionId, reason));
    host?.onScreen((sessionId, index) => {
      const s = this.sessions.get(sessionId);
      if (s?.state !== 'open' || s.role !== 'viewer') return;
      this.o.links.send(s.peer, 'assist.screen', { sessionId, index });
    });
    host?.onControl((sessionId, on) => {
      const s = this.sessions.get(sessionId);
      // Only the sharing side says whether it is being controlled.
      if (s?.role !== 'sharer' || s.state !== 'open' || s.control === on) return;
      s.control = on;
      this.changed();
    });
    host?.onChat((sessionId) => {
      const s = this.sessions.get(sessionId);
      if (s && s.state !== 'ended') this.o.openChat(s.peer);
    });
  }

  list(): AssistView[] {
    const now = this.o.clock.now();
    for (const [id, s] of this.sessions)
      if (s.state === 'ended' && now - s.at > ENDED_KEPT_MS) this.sessions.delete(id);
    return [...this.sessions.values()].map(view);
  }

  status(): Promise<AssistStatus> {
    return this.o.host?.status() ?? Promise.resolve({ available: false, allowed: false });
  }

  openSettings(): void {
    this.o.host?.openSettings();
  }

  async request(peer: string, kind: AssistKind): Promise<AssistView> {
    if (peer === this.o.selfId) throw new Error('You cannot ask yourself.');
    if (!this.o.host) throw new Error('Remote help is not available here.');
    if (this.active()) throw new Error('A remote help session is already going on.');
    const status = await this.o.host.status();
    if (!status.available) throw new Error('Remote help is not available on this PC.');
    if (!this.o.links.isReady(peer)) await this.o.connect(peer);
    if (!this.o.links.isReady(peer)) throw new Error('They are not reachable right now.');
    if (!this.o.links.hasCap(peer, 'assist.v2'))
      throw new Error('Their InterCom is too old for remote help: they need to update it.');
    const s: Session = {
      sessionId: randomBytes(16).toString('base64url'),
      peer,
      kind,
      mine: true,
      role: kind === 'help-me' ? 'sharer' : 'viewer',
      state: 'asking',
      at: this.o.clock.now(),
    };
    this.sessions.set(s.sessionId, s);
    this.o.links.send(peer, 'assist.request', { sessionId: s.sessionId, kind });
    this.arm(s, ASSIST_ANSWER_MS, () => {
      this.o.links.send(peer, 'assist.end', { sessionId: s.sessionId, reason: 'no-answer' });
      this.finish(s, 'no-answer', 'peer');
    });
    this.changed();
    return view(s);
  }

  async accept(sessionId: string): Promise<AssistView> {
    const s = this.need(sessionId);
    if (s.state !== 'asked') return view(s);
    const status = await this.status();
    if (!status.available) throw new Error('Remote help is not available on this PC.');
    this.o.links.send(s.peer, 'assist.accept', { sessionId });
    s.state = 'starting';
    s.at = this.o.clock.now();
    this.changed();
    if (s.role === 'sharer') await this.share(s);
    else this.awaitTicket(s);
    return view(s);
  }

  decline(sessionId: string): AssistView {
    const s = this.need(sessionId);
    if (s.state !== 'asked') return view(s);
    this.o.links.send(s.peer, 'assist.decline', { sessionId, reason: 'declined' });
    this.finish(s, 'declined', 'me');
    return view(s);
  }

  end(sessionId: string): AssistView {
    const s = this.need(sessionId);
    if (s.state === 'ended') return view(s);
    if (s.state === 'asked') return this.decline(sessionId);
    this.o.links.send(s.peer, 'assist.end', { sessionId, reason: 'cancelled' });
    this.finish(s, 'cancelled', 'me');
    return view(s);
  }

  /** The sharing side lets the colleague control this PC, or takes it back (they can still look). */
  setControl(sessionId: string, on: boolean): AssistView {
    const s = this.need(sessionId);
    if (s.role !== 'sharer' || s.state !== 'open')
      throw new Error('Control can only be changed on the shared PC while the session is open.');
    this.o.host?.setControl(sessionId, on);
    s.control = on;
    this.changed();
    return view(s);
  }

  dismiss(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s?.state !== 'ended') return;
    this.sessions.delete(sessionId);
    this.changed();
  }

  stop(): void {
    for (const s of this.sessions.values())
      if (s.state !== 'ended') {
        this.o.links.send(s.peer, 'assist.end', { sessionId: s.sessionId, reason: 'closed' });
        this.finish(s, 'closed', 'me');
      }
  }

  // ---------------------------------------------------------------------------

  private onRequest(from: string, raw: unknown): void {
    const body = AssistRequestBody.safeParse(raw);
    if (!body.success || this.sessions.has(body.data.sessionId)) return;
    const { sessionId, kind } = body.data;
    if (this.active() || !this.o.host) {
      this.o.links.send(from, 'assist.decline', {
        sessionId,
        reason: this.o.host ? 'busy' : 'unavailable',
      });
      return;
    }
    const s: Session = {
      sessionId,
      peer: from,
      kind,
      mine: false,
      // They asked for help: their desktop shows here. They asked to come in: this one shows.
      role: kind === 'help-me' ? 'viewer' : 'sharer',
      state: 'asked',
      at: this.o.clock.now(),
    };
    this.sessions.set(sessionId, s);
    // Unanswered, it lapses here too (the asker gives up at the same time).
    this.arm(s, ASSIST_ANSWER_MS + 5_000, () => this.finish(s, 'no-answer', 'me'));
    this.changed();
    this.o.asked(view(s));
  }

  private async onAccept(from: string, raw: unknown): Promise<void> {
    const body = AssistIdBody.safeParse(raw);
    const s = body.success ? this.sessions.get(body.data.sessionId) : undefined;
    if (!s || s.peer !== from || !s.mine || s.state !== 'asking') return;
    s.state = 'starting';
    s.at = this.o.clock.now();
    this.changed();
    if (s.role === 'sharer') await this.share(s);
    else this.awaitTicket(s);
  }

  private onDecline(from: string, raw: unknown): void {
    const body = AssistDeclineBody.safeParse(raw);
    const s = body.success ? this.sessions.get(body.data.sessionId) : undefined;
    if (!s || s.peer !== from || s.state === 'ended') return;
    this.finish(s, body.data!.reason, 'peer');
  }

  private async onTicket(from: string, raw: unknown): Promise<void> {
    const body = AssistTicketBody.safeParse(raw);
    const s = body.success ? this.sessions.get(body.data.sessionId) : undefined;
    // Only the viewer of a session it agreed to, from that colleague, connects to anything.
    if (!s || s.peer !== from || s.role !== 'viewer' || s.state !== 'starting') return;
    const { ticket, password, screens } = body.data!;
    if (!CONNECTION_STRING.test(ticket)) {
      this.o.links.send(from, 'assist.end', { sessionId: s.sessionId, reason: 'failed' });
      this.finish(s, 'failed', 'peer');
      return;
    }
    try {
      await this.o.host!.view(s.sessionId, {
        ticket,
        password,
        screens: screens ?? [],
        peerName: this.o.nameOf(s.peer),
        selfName: this.o.selfName(),
      });
    } catch (err) {
      this.o.logger.warn('remote help viewer did not start', { err: String(err) });
      this.o.links.send(from, 'assist.end', { sessionId: s.sessionId, reason: 'failed' });
      this.finish(s, 'failed', 'me');
      return;
    }
    if (s.state !== 'starting') return;
    this.disarm(s);
    s.state = 'open';
    s.at = this.o.clock.now();
    this.changed();
  }

  /** The viewer chose a screen: only the one being shown, from that colleague, in an open session. */
  private onScreen(from: string, raw: unknown): void {
    const body = AssistScreenBody.safeParse(raw);
    const s = body.success ? this.sessions.get(body.data.sessionId) : undefined;
    if (!s || s.peer !== from || s.role !== 'sharer' || s.state !== 'open') return;
    const { index } = body.data!;
    if (index >= (s.screenCount ?? 0)) return;
    this.o.host?.selectScreen(s.sessionId, index);
  }

  private onEnd(from: string, raw: unknown): void {
    const body = AssistEndBody.safeParse(raw);
    const s = body.success ? this.sessions.get(body.data.sessionId) : undefined;
    if (!s || s.peer !== from || s.state === 'ended') return;
    const reason = body.data!.reason ?? 'closed';
    this.finish(s, reason === 'no-answer' && !s.mine ? 'no-answer' : reason, 'peer');
  }

  /** A helper ended on its own: the person closed it, the colleague left, or it broke. */
  private onHostExit(sessionId: string, exit: AssistExit): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.state === 'ended') return;
    const end = (reason: 'closed' | 'failed' | 'no-connection') =>
      this.o.links.send(s.peer, 'assist.end', { sessionId, reason });
    switch (exit) {
      case 'closed':
        end('closed');
        this.finish(s, 'closed', 'me', false);
        return;
      case 'peer-left':
        this.finish(s, 'closed', 'peer', false);
        return;
      case 'no-connection':
        end('no-connection');
        this.finish(s, 'no-connection', 'me', false);
        return;
      case 'failed':
        end('failed');
        this.finish(s, 'failed', 'me', false);
        return;
    }
  }

  /** This PC's desktop is shown: start sharing it and send the colleague what they need. */
  private async share(s: Session): Promise<void> {
    this.arm(s, ASSIST_TICKET_MS, () => {
      this.o.links.send(s.peer, 'assist.end', { sessionId: s.sessionId, reason: 'failed' });
      this.finish(s, 'failed', 'me');
    });
    let started: { ticket: string; password: string; screens: AssistScreen[] };
    try {
      started = await this.o.host!.share(s.sessionId, this.o.nameOf(s.peer));
    } catch (err) {
      this.o.logger.warn('remote help sharing did not start', { err: String(err) });
      if (s.state === 'ended') return;
      this.o.links.send(s.peer, 'assist.end', { sessionId: s.sessionId, reason: 'failed' });
      this.finish(s, 'failed', 'me');
      return;
    }
    // Cancelled while Windows was getting ready.
    if (s.state !== 'starting') return this.o.host!.stop(s.sessionId);
    s.screenCount = started.screens.length;
    if (
      !this.o.links.send(s.peer, 'assist.ticket', {
        sessionId: s.sessionId,
        ticket: started.ticket,
        password: started.password,
        screens: started.screens,
      })
    ) {
      this.finish(s, 'lost', 'peer');
      return;
    }
    this.disarm(s);
    s.state = 'open';
    s.at = this.o.clock.now();
    this.changed();
  }

  /** This PC shows the colleague's desktop: wait for the connection details. */
  private awaitTicket(s: Session): void {
    this.arm(s, ASSIST_TICKET_MS, () => {
      this.o.links.send(s.peer, 'assist.end', { sessionId: s.sessionId, reason: 'failed' });
      this.finish(s, 'failed', 'peer');
    });
  }

  private finish(s: Session, reason: Reason, by: 'me' | 'peer', stopHost = true): void {
    if (s.state === 'ended') return;
    this.disarm(s);
    const wasOpen = s.state === 'open' || s.state === 'starting';
    s.state = 'ended';
    s.endReason = reason;
    s.endedBy = by;
    s.at = this.o.clock.now();
    if (stopHost && wasOpen) this.o.host?.stop(s.sessionId);
    this.changed();
  }

  private active(): boolean {
    return [...this.sessions.values()].some((s) => s.state !== 'ended');
  }

  private need(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('That remote help session is over.');
    return s;
  }

  private arm(s: Session, ms: number, fire: () => void): void {
    this.disarm(s);
    s.timer = this.o.clock.setTimeout(() => {
      delete s.timer;
      if (s.state !== 'ended') fire();
    }, ms);
  }

  private disarm(s: Session): void {
    if (s.timer) this.o.clock.clearTimeout(s.timer);
    delete s.timer;
  }

  private changed(): void {
    this.o.changed(this.list());
  }
}

function view(s: Session): AssistView {
  return {
    sessionId: s.sessionId,
    peer: s.peer,
    kind: s.kind,
    mine: s.mine,
    role: s.role,
    state: s.state,
    ...(s.control !== undefined && { control: s.control }),
    ...(s.endReason && { endReason: s.endReason }),
    ...(s.endedBy && { endedBy: s.endedBy }),
    at: s.at,
  };
}

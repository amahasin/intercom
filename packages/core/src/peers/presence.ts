import {
  ManualPresenceState,
  type PresenceState,
  type ManualPresenceState as Manual,
} from '@officemesh/protocol';
import type { PresenceView } from '@officemesh/protocol/ipc';
import type { Clock } from '../interfaces.ts';
import type { Store } from '../store/store.ts';

const SETTING = 'presence.manual';
/** How long the PC is idle before it counts as Away (the main process decides; see the host). */
const IDLE_AFTER_MS = 5 * 60_000;
/** Manual states that turn into Away while the PC is idle or locked. */
const AUTO_AWAY_FROM: ReadonlySet<Manual> = new Set(['available', 'busy']);

/**
 * The user's own presence: the state they picked, overridden by Away after 5 minutes idle
 * or while the screen is locked (idle detection lives in the main process).
 */
export class PresenceService {
  private manual: Manual;
  private idle = false;
  private locked = false;
  private inCall = false;
  private readonly store: Store;
  private readonly clock: Clock;
  /** When the state colleagues see last changed (an idle PC: when the idleness began). */
  private since: number;
  private readonly listeners = new Set<(view: PresenceView) => void>();

  constructor(store: Store, clock: Clock) {
    this.store = store;
    this.clock = clock;
    this.since = clock.now();
    const saved = ManualPresenceState.safeParse(store.getSetting(SETTING));
    this.manual = saved.success ? saved.data : 'available';
  }

  effective(): PresenceState {
    // In a call, Available shows as Busy, and idle does not make a caller Away.
    if (this.inCall && this.manual === 'available') return 'busy';
    if (this.inCall && this.manual === 'busy') return 'busy';
    if ((this.idle || this.locked) && AUTO_AWAY_FROM.has(this.manual)) return 'away';
    return this.manual;
  }

  /** When the state colleagues see last changed: they show it as last seen for someone away. */
  changedAt(): number {
    return this.since;
  }

  private noteChange(before: PresenceState, backdate = 0): void {
    if (before !== this.effective()) this.since = this.clock.now() - backdate;
  }

  isInCall(): boolean {
    return this.inCall;
  }

  setInCall(inCall: boolean): void {
    if (inCall === this.inCall) return;
    const before = this.effective();
    this.inCall = inCall;
    this.noteChange(before);
    if (before !== this.effective()) this.changed();
  }

  view(): PresenceView {
    return {
      manual: this.manual,
      effective: this.effective(),
      ...(this.inCall && { inCall: true }),
      idle: this.idle,
      locked: this.locked,
    };
  }

  setManual(state: Manual): PresenceView {
    const before = this.effective();
    this.manual = state;
    this.store.setSetting(SETTING, state);
    this.noteChange(before);
    return this.changed();
  }

  setSystem(state: { idle?: boolean; locked?: boolean }): void {
    const before = this.effective();
    const beforeFlags = `${this.idle}/${this.locked}`;
    const wasIdle = this.idle;
    if (state.idle !== undefined) this.idle = state.idle;
    if (state.locked !== undefined) this.locked = state.locked;
    // Idle means no input for the last 5 minutes, so that is when they were last there.
    this.noteChange(before, state.idle === true && !wasIdle ? IDLE_AFTER_MS : 0);
    if (before !== this.effective() || beforeFlags !== `${this.idle}/${this.locked}`)
      this.changed();
  }

  onChange(listener: (view: PresenceView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): PresenceView {
    const view = this.view();
    for (const l of this.listeners) l(view);
    return view;
  }
}

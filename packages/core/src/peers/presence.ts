import {
  ManualPresenceState,
  type PresenceState,
  type ManualPresenceState as Manual,
} from '@officemesh/protocol';
import type { PresenceView } from '@officemesh/protocol/ipc';
import type { Store } from '../store/store.ts';

const SETTING = 'presence.manual';
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
  private readonly listeners = new Set<(view: PresenceView) => void>();

  constructor(store: Store) {
    this.store = store;
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

  isInCall(): boolean {
    return this.inCall;
  }

  setInCall(inCall: boolean): void {
    if (inCall === this.inCall) return;
    const before = this.effective();
    this.inCall = inCall;
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
    this.manual = state;
    this.store.setSetting(SETTING, state);
    return this.changed();
  }

  setSystem(state: { idle?: boolean; locked?: boolean }): void {
    const before = this.effective();
    const beforeFlags = `${this.idle}/${this.locked}`;
    if (state.idle !== undefined) this.idle = state.idle;
    if (state.locked !== undefined) this.locked = state.locked;
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

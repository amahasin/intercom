/**
 * Which composers hold something typed that has not been sent. Nothing else reads this but the
 * report to the core (`UnsentReporter`), which does not restart the app for an update while
 * anything is here: a restart would lose it.
 */
import { create } from 'zustand';

interface DraftState {
  /** The composers with something in them (by `composerKey`, plus `|poll` for a poll being made). */
  keys: Record<string, true>;
  /** How many. */
  count: number;
  set(key: string, held: boolean): void;
}

export const useDrafts = create<DraftState>((set) => ({
  keys: {},
  count: 0,
  set: (key, held) =>
    set((s) => {
      if (held === (s.keys[key] === true)) return s;
      const keys = { ...s.keys };
      if (held) keys[key] = true;
      else delete keys[key];
      return { keys, count: Object.keys(keys).length };
    }),
}));

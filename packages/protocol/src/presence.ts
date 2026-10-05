import { z } from 'zod';

export const PresenceState = z.enum(['available', 'busy', 'dnd', 'brb', 'away', 'offline']);
export type PresenceState = z.infer<typeof PresenceState>;

/** States a user can pick by hand. `offline` is only ever inferred. */
export const ManualPresenceState = PresenceState.exclude(['offline']);
export type ManualPresenceState = z.infer<typeof ManualPresenceState>;

export const PRESENCE_LABELS: Record<PresenceState, string> = {
  available: 'Available',
  busy: 'Busy',
  dnd: 'Do not disturb',
  brb: 'Be right back',
  away: 'Away',
  offline: 'Offline',
};

export const AUTO_AWAY_AFTER_MS = 5 * 60 * 1000;

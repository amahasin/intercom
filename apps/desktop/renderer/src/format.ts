import type { PresenceState } from '@officemesh/protocol';

type BadgeStatus = 'available' | 'away' | 'busy' | 'do-not-disturb' | 'offline';

/** Map a presence state onto Fluent's avatar badge statuses. */
export function presenceBadge(state: PresenceState): {
  status: BadgeStatus;
  outOfOffice?: boolean;
} {
  switch (state) {
    case 'available':
      return { status: 'available' };
    case 'busy':
      return { status: 'busy' };
    case 'dnd':
      return { status: 'do-not-disturb' };
    case 'brb':
    case 'away':
      return { status: 'away' };
    case 'offline':
      return { status: 'offline' };
  }
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** "10:42" today, "Mon 10:42" this week, "5 Oct" otherwise. */
export function shortTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time.format(d);
  if (now - ms < 6 * 86_400_000) return dayTime.format(d);
  return date.format(d);
}

export function relativeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return shortTime(ms, now);
}

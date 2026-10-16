import type { PresenceState } from '@officemesh/protocol';
import { strings } from './strings.ts';

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

/** "Available", ... or "In a call" for someone who is in one (their state on the wire says Busy). */
export function presenceText(person: {
  presence: PresenceState;
  inCall?: boolean | undefined;
}): string {
  return person.inCall ? strings.inCallStatus : strings.presence[person.presence];
}

/**
 * Where someone is, in a line: their state when they are online ("Available", "In a call"), and
 * when they are not, when they were last seen ("Offline · last seen 45 min ago").
 */
export function presenceLine(person: {
  presence: PresenceState;
  inCall?: boolean | undefined;
  online?: boolean | undefined;
  lastSeen?: number | undefined;
  presenceSince?: number | undefined;
}): string {
  if (person.online === false && person.lastSeen !== undefined)
    return strings.person.offlineSince(relativeAgo(person.lastSeen));
  // Someone who is away: since when they were last there ("Away · last seen 40 min ago").
  if (
    !person.inCall &&
    (person.presence === 'away' || person.presence === 'brb') &&
    person.presenceSince !== undefined
  )
    return strings.person.awaySince(presenceText(person), relativeAgo(person.presenceSince));
  return presenceText(person);
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

/**
 * The longest note a profile holds, and what counts as an email address. Both mirror
 * `MAX_NOTES` / `EMAIL_PATTERN` in the protocol package (the renderer takes only types from it so
 * the schema library stays out of the page); a test keeps the two in step.
 */
export const NOTES_MAX = 1000;
export const EMAIL_RE = /^[^\s@<>"'()[\],;:\\]+@[^\s@<>"'()[\],;:\\]+\.[^\s@<>"'()[\],;:\\]{2,}$/;
export const isEmail = (text: string): boolean => EMAIL_RE.test(text.trim());

/** A moment to the second, in the PC's own format: "15 Oct 2026, 10:42:15". */
export function exactTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function relativeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86_400);
  if (days < 30) return `${days} d ago`;
  return shortTime(ms, now);
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const weekdayTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  hour: 'numeric',
  minute: '2-digit',
});
const numericDayTime = new Intl.DateTimeFormat(undefined, {
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const numericDayYearTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const longDay = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const longDayYear = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Whole calendar days from `ms` to `now` (0 = today), whatever the time of day. */
function daysAgo(ms: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
}

/** A key that is the same for every message of one calendar day. */
export const dayKey = (ms: number): number => startOfDay(ms);

/**
 * The time over a message, as Teams writes it: "10:09 AM" today, "Wednesday 4:11 PM" within
 * the week, "9/29 12:08 PM" before that (with the year when it is not this one).
 */
export function messageTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const ago = daysAgo(ms, now);
  if (ago <= 0) return time.format(d);
  if (ago < 7) return weekdayTime.format(d);
  return (d.getFullYear() === new Date(now).getFullYear() ? numericDayTime : numericDayYearTime)
    .format(d)
    .replace(',', '');
}

/** The line between days: "Today", "Yesterday", "Thursday", "Tuesday, September 29". */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const ago = daysAgo(ms, now);
  if (ago <= 0) return strings.chat.today;
  if (ago === 1) return strings.chat.yesterday;
  if (ago < 7) return weekday.format(d);
  return (d.getFullYear() === new Date(now).getFullYear() ? longDay : longDayYear).format(d);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

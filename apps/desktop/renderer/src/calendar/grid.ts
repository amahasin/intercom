/**
 * Calendar maths with no UI in it: which days a view shows, where a meeting sits in a day
 * column (and beside which others), what a mouse position means as a time, and which
 * meetings a filter keeps. Kept apart from React so it can be tested on its own.
 */
import type { MeetingOccurrence } from '@officemesh/protocol/ipc';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
/** Time slots snap to this many minutes when the user clicks or drags. */
export const SLOT_MINUTES = 30;

export type CalendarViewKind = 'day' | 'workweek' | 'week' | 'month';
export type CalendarFilter = 'all' | 'organizer' | 'accepted' | 'pending' | 'recurring';

export interface WeekInfo {
  /** First day of the week, 0 = Sunday … 6 = Saturday. */
  first: number;
  /** Days that are not working days (0 = Sunday … 6 = Saturday). */
  weekend: number[];
}

/** The week as the locale sees it (Monday-first in most of Europe, Sunday-first in the US…). */
export function weekInfoFor(locale: string): WeekInfo {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number; weekend: number[] };
      weekInfo?: { firstDay: number; weekend: number[] };
    };
    const w = l.getWeekInfo?.() ?? l.weekInfo;
    // The standard numbers Monday 1 … Sunday 7; Date.getDay() has Sunday 0.
    if (w) return { first: w.firstDay % 7, weekend: w.weekend.map((d) => d % 7) };
  } catch {
    // An unknown locale: use the usual week.
  }
  return { first: 1, weekend: [6, 0] };
}

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(t: number, n: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function startOfMonth(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function addMonths(t: number, n: number): number {
  const d = new Date(t);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes());
  // Jan 31 + 1 month is Feb 28, not March 3.
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, last));
  return target.getTime();
}

export function startOfWeek(t: number, first: number): number {
  const day = startOfDay(t);
  const back = (new Date(day).getDay() - first + 7) % 7;
  return addDays(day, -back);
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** The columns of a day, work-week or week view around `anchor`. */
export function daysFor(view: Exclude<CalendarViewKind, 'month'>, anchor: number, wk: WeekInfo) {
  const day = startOfDay(anchor);
  if (view === 'day') return [day];
  const start = startOfWeek(day, wk.first);
  const all = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return view === 'workweek' ? all.filter((d) => !wk.weekend.includes(new Date(d).getDay())) : all;
}

/** Six weeks starting on the week's first day, covering the month of `anchor`. */
export function monthGrid(anchor: number, wk: WeekInfo): number[] {
  const start = startOfWeek(startOfMonth(anchor), wk.first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** [from, to) of what a view needs from the core. */
export function rangeFor(view: CalendarViewKind, anchor: number, wk: WeekInfo): [number, number] {
  if (view === 'month') {
    const grid = monthGrid(anchor, wk);
    return [grid[0]!, addDays(grid.at(-1)!, 1)];
  }
  const days = daysFor(view, anchor, wk);
  return [days[0]!, addDays(days.at(-1)!, 1)];
}

/** Move an anchor by one screenful: a day, a week or a month. */
export function step(view: CalendarViewKind, anchor: number, direction: 1 | -1): number {
  if (view === 'month') return addMonths(anchor, direction);
  return addDays(anchor, direction * (view === 'day' ? 1 : 7));
}

export interface Placed {
  m: MeetingOccurrence;
  /** Hours from the top of the day. */
  top: number;
  height: number;
  /** Which of `cols` side-by-side columns this meeting takes. */
  col: number;
  cols: number;
}

/**
 * Where each meeting sits in one day's column. Meetings that overlap in time share the
 * width side by side (like Outlook and Teams), instead of hiding each other.
 */
export function layoutDay(meetings: MeetingOccurrence[], day: number, minHours = 0.45): Placed[] {
  const items = meetings
    .filter((m) => m.start < day + DAY_MS && m.end > day)
    .map((m) => ({ m, s: Math.max(m.start, day), e: Math.min(m.end, day + DAY_MS) }))
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const p of cluster) p.cols = colEnds.length;
    out.push(...cluster);
    cluster = [];
    colEnds = [];
  };
  for (const { m, s, e } of items) {
    if (s >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= s);
    if (col < 0) col = colEnds.length;
    colEnds[col] = e;
    clusterEnd = Math.max(clusterEnd, e);
    cluster.push({
      m,
      top: (s - day) / HOUR_MS,
      height: Math.max(minHours, (e - s) / HOUR_MS),
      col,
      cols: 1,
    });
  }
  flush();
  return out;
}

/** Minutes from the top of a day column for a pointer `y` pixels down it, snapped to a slot. */
export function minutesAt(y: number, hourPx: number, snap = SLOT_MINUTES): number {
  const raw = (Math.max(0, y) / hourPx) * 60;
  return Math.min(24 * 60 - snap, Math.floor(raw / snap) * snap);
}

/** A click or drag from one slot to another, as a start and end (always at least one slot). */
export function slotRange(
  day: number,
  fromMinutes: number,
  toMinutes: number,
  snap = SLOT_MINUTES,
): { start: number; end: number } {
  const a = Math.min(fromMinutes, toMinutes);
  const b = Math.max(fromMinutes, toMinutes) + snap;
  const at = new Date(day);
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, a).getTime();
  const end = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, b).getTime();
  return { start, end };
}

/** Which meetings a filter keeps. */
export function keepMeeting(m: MeetingOccurrence, filter: CalendarFilter, selfId: string): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'organizer':
      return m.organizer === selfId;
    case 'accepted':
      return m.organizer === selfId || m.myResponse === 'accepted' || m.myResponse === 'tentative';
    case 'pending':
      return m.organizer !== selfId && m.myResponse === undefined && !m.cancelled;
    case 'recurring':
      return m.recurrence.freq !== 'none';
  }
}

/** "Oct 5–11, 2026", "Sep 28 – Oct 4, 2026", "Tuesday, Oct 6, 2026" or "October 2026". */
export function rangeLabel(
  view: CalendarViewKind,
  anchor: number,
  days: number[],
  locale?: string,
): string {
  if (view === 'month')
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor);
  if (view === 'day')
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(anchor);
  const first = new Date(days[0]!);
  const last = new Date(days.at(-1)!);
  const month = new Intl.DateTimeFormat(locale, { month: 'long' });
  const monthShort = new Intl.DateTimeFormat(locale, { month: 'short' });
  if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear())
    return `${month.format(first)} ${first.getDate()}–${last.getDate()}, ${last.getFullYear()}`;
  const sameYear = first.getFullYear() === last.getFullYear();
  return `${monthShort.format(first)} ${first.getDate()}${sameYear ? '' : `, ${first.getFullYear()}`} – ${monthShort.format(last)} ${last.getDate()}, ${last.getFullYear()}`;
}

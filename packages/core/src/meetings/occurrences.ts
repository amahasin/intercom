import type { Recurrence } from '@officemesh/protocol';

export interface MeetingTimes {
  start: number;
  end: number;
  recurrence: Recurrence;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Never expand more than this many occurrences for one query. */
const MAX_OCCURRENCES = 1_000;

/** Step one day in local time (keeps the wall-clock time across a daylight-saving change). */
function nextDay(t: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

function isWeekday(t: number): boolean {
  const day = new Date(t).getDay();
  return day >= 1 && day <= 5;
}

/**
 * Start times of a meeting's occurrences that overlap [from, to). Occurrences step from
 * the first one in local time: every day, every weekday (Monday to Friday) or every week.
 */
export function occurrences(m: MeetingTimes, from: number, to: number): number[] {
  const length = m.end - m.start;
  const out: number[] = [];
  const until = m.recurrence.until ?? Number.POSITIVE_INFINITY;
  if (m.recurrence.freq === 'none') {
    return m.start < to && m.start + length > from ? [m.start] : [];
  }
  let t = m.start;
  // Skip whole weeks or days quickly when the window is far after the first occurrence.
  if (from - length > t) {
    const step = m.recurrence.freq === 'weekly' ? 7 * DAY_MS : DAY_MS;
    const skip = Math.floor((from - length - t) / step) - 1;
    if (skip > 0) {
      for (let i = 0; i < skip * (step / DAY_MS); i++) t = nextDay(t);
    }
  }
  while (t < to && t < until && out.length < MAX_OCCURRENCES) {
    const counts = m.recurrence.freq !== 'weekdays' || isWeekday(t);
    if (counts && t + length > from && t >= m.start) out.push(t);
    if (m.recurrence.freq === 'weekly') for (let i = 0; i < 7; i++) t = nextDay(t);
    else t = nextDay(t);
  }
  return out;
}

/** The next occurrence starting at or after `after`, if any (for reminders). */
export function nextOccurrence(
  m: MeetingTimes,
  after: number,
  horizonMs: number,
): number | undefined {
  return occurrences(m, after, after + horizonMs).find((t) => t >= after);
}

// ---------------------------------------------------------------------------
// iCalendar (.ics) export, RFC 5545
// ---------------------------------------------------------------------------

function icsTime(t: number): string {
  return new Date(t)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Escape TEXT values and fold lines at 75 octets. */
function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, 'utf8') > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > 75) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts.join('\r\n ');
}

export interface IcsMeeting extends MeetingTimes {
  uid: string;
  title: string;
  notes?: string | undefined;
  organizer: string;
  attendees: string[];
  /** Cancelled occurrences (their start times). */
  exceptions: number[];
  cancelled: boolean;
  stamp: number;
}

export function toIcs(m: IcsMeeting): string {
  const rule: Record<Recurrence['freq'], string | undefined> = {
    none: undefined,
    daily: 'FREQ=DAILY',
    weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    weekly: 'FREQ=WEEKLY',
  };
  const rrule = rule[m.recurrence.freq];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//InterCom//Meetings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${m.uid}`,
    `DTSTAMP:${icsTime(m.stamp)}`,
    `DTSTART:${icsTime(m.start)}`,
    `DTEND:${icsTime(m.end)}`,
    `SUMMARY:${icsText(m.title)}`,
    ...(m.notes ? [`DESCRIPTION:${icsText(m.notes)}`] : []),
    `ORGANIZER;CN=${icsText(m.organizer)}:MAILTO:noreply@intercom.invalid`,
    ...m.attendees.map((a) => `ATTENDEE;CN=${icsText(a)}:MAILTO:noreply@intercom.invalid`),
    ...(rrule
      ? [`RRULE:${rrule}${m.recurrence.until ? `;UNTIL=${icsTime(m.recurrence.until)}` : ''}`]
      : []),
    ...m.exceptions.map((t) => `EXDATE:${icsTime(t)}`),
    `STATUS:${m.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

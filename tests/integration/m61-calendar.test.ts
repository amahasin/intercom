import { describe, expect, it } from 'vitest';
import type { MeetingOccurrence } from '@officemesh/protocol/ipc';
import {
  addDays,
  addMonths,
  daysFor,
  keepMeeting,
  layoutDay,
  minutesAt,
  monthGrid,
  rangeFor,
  rangeLabel,
  slotRange,
  startOfDay,
  startOfWeek,
  step,
  weekInfoFor,
  type WeekInfo,
} from '../../apps/desktop/renderer/src/calendar/grid.ts';

const sundayFirst: WeekInfo = { first: 0, weekend: [6, 0] };
const mondayFirst: WeekInfo = { first: 1, weekend: [6, 0] };
const hour = (day: number, h: number, m = 0) => {
  const d = new Date(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
};
const tuesday = new Date(2026, 9, 6, 15, 20).getTime(); // 6 October 2026

function meeting(over: Partial<MeetingOccurrence>): MeetingOccurrence {
  return {
    convId: 'c',
    conversation: 'Chat',
    target: { author: 'a', seq: 1 },
    organizer: 'org',
    title: 'Meeting',
    start: 0,
    end: 0,
    recurrence: { freq: 'none' },
    cancelled: false,
    attendees: [],
    rsvps: [],
    live: false,
    ...over,
  };
}

describe('calendar views', () => {
  it('shows the week from the locale’s first day, and a work week without the days off', () => {
    const sunFirst = daysFor('week', tuesday, sundayFirst);
    expect(sunFirst).toHaveLength(7);
    expect(new Date(sunFirst[0]!).getDay()).toBe(0);
    expect(new Date(sunFirst[0]!).getDate()).toBe(4); // Sunday 4 October
    const monFirst = daysFor('week', tuesday, mondayFirst);
    expect(new Date(monFirst[0]!).getDate()).toBe(5);
    expect(new Date(monFirst[6]!).getDate()).toBe(11);
    const work = daysFor('workweek', tuesday, mondayFirst);
    expect(work.map((d) => new Date(d).getDate())).toEqual([5, 6, 7, 8, 9]);
    // Where the weekend is Friday and Saturday, those are the days off instead.
    const gulf = daysFor('workweek', tuesday, { first: 0, weekend: [5, 6] });
    expect(gulf.map((d) => new Date(d).getDay())).toEqual([0, 1, 2, 3, 4]);
    expect(daysFor('day', tuesday, mondayFirst)).toEqual([startOfDay(tuesday)]);
  });

  it('lays a month out as six whole weeks around it', () => {
    const grid = monthGrid(tuesday, mondayFirst);
    expect(grid).toHaveLength(42);
    expect(new Date(grid[0]!).getDay()).toBe(1);
    expect(grid).toContain(startOfDay(tuesday));
    expect(new Date(grid[0]!).getTime()).toBeLessThanOrEqual(new Date(2026, 9, 1).getTime());
    expect(rangeFor('month', tuesday, mondayFirst)).toEqual([grid[0], addDays(grid[41]!, 1)]);
    const [from, to] = rangeFor('workweek', tuesday, mondayFirst);
    expect(new Date(from).getDate()).toBe(5);
    expect(new Date(to).getDate()).toBe(10);
  });

  it('steps by a day, a week or a month, and never overflows a short month', () => {
    expect(new Date(step('day', tuesday, 1)).getDate()).toBe(7);
    expect(new Date(step('week', tuesday, -1)).getDate()).toBe(29);
    expect(new Date(step('month', tuesday, 1)).getMonth()).toBe(10);
    const jan31 = new Date(2026, 0, 31).getTime();
    const feb = new Date(addMonths(jan31, 1));
    expect(feb.getMonth()).toBe(1);
    expect(feb.getDate()).toBe(28);
    expect(startOfWeek(tuesday, 1)).toBe(new Date(2026, 9, 5).getTime());
  });

  it('knows the week of a locale (when the platform can say)', () => {
    const us = weekInfoFor('en-US');
    const gb = weekInfoFor('en-GB');
    expect(us.first).toBe(0);
    expect(gb.first).toBe(1);
    expect(weekInfoFor('not a locale!!').first).toBe(1);
  });

  it('labels the range', () => {
    const week = daysFor('week', tuesday, mondayFirst);
    expect(rangeLabel('week', tuesday, week, 'en-US')).toBe('October 5–11, 2026');
    const crossing = daysFor('week', new Date(2026, 9, 1).getTime(), mondayFirst);
    expect(rangeLabel('week', tuesday, crossing, 'en-US')).toBe('Sep 28 – Oct 4, 2026');
    expect(rangeLabel('day', tuesday, [], 'en-US')).toBe('Tuesday, October 6, 2026');
    expect(rangeLabel('month', tuesday, [], 'en-US')).toBe('October 2026');
  });
});

describe('meetings in a day column', () => {
  const day = startOfDay(tuesday);

  it('puts a meeting at its time, with a minimum height', () => {
    const [p] = layoutDay([meeting({ start: hour(day, 9), end: hour(day, 10, 30) })], day);
    expect(p).toMatchObject({ top: 9, height: 1.5, col: 0, cols: 1 });
    const [short] = layoutDay([meeting({ start: hour(day, 9), end: hour(day, 9, 5) })], day);
    expect(short!.height).toBeGreaterThanOrEqual(0.4);
  });

  it('shares the width between meetings that overlap, and not with those that do not', () => {
    const placed = layoutDay(
      [
        meeting({ title: 'A', start: hour(day, 9), end: hour(day, 11) }),
        meeting({ title: 'B', start: hour(day, 10), end: hour(day, 12) }),
        meeting({ title: 'C', start: hour(day, 10, 30), end: hour(day, 11, 30) }),
        meeting({ title: 'D', start: hour(day, 14), end: hour(day, 15) }),
      ],
      day,
    );
    const by = Object.fromEntries(placed.map((p) => [p.m.title, p]));
    expect(by['A']).toMatchObject({ col: 0, cols: 3 });
    expect(by['B']).toMatchObject({ col: 1, cols: 3 });
    expect(by['C']).toMatchObject({ col: 2, cols: 3 });
    expect(by['D']).toMatchObject({ col: 0, cols: 1 });
  });

  it('reuses a free column when an earlier meeting has ended', () => {
    const placed = layoutDay(
      [
        meeting({ title: 'A', start: hour(day, 9), end: hour(day, 10) }),
        meeting({ title: 'B', start: hour(day, 9, 30), end: hour(day, 12) }),
        meeting({ title: 'C', start: hour(day, 10, 15), end: hour(day, 11) }),
      ],
      day,
    );
    const by = Object.fromEntries(placed.map((p) => [p.m.title, p]));
    expect(by['C']!.col).toBe(0);
    expect(by['A']!.cols).toBe(2);
  });

  it('clips a meeting that runs past midnight to each day it touches', () => {
    const late = meeting({ start: hour(day, 23), end: hour(addDays(day, 1), 1) });
    const [today] = layoutDay([late], day);
    expect(today!.top + today!.height).toBeCloseTo(24, 5);
    const [next] = layoutDay([late], addDays(day, 1));
    expect(next).toMatchObject({ top: 0, height: 1 });
    expect(layoutDay([late], addDays(day, 2))).toEqual([]);
  });
});

describe('time slots', () => {
  it('turns a pointer position into half-hour slots', () => {
    expect(minutesAt(0, 64)).toBe(0);
    expect(minutesAt(-20, 64)).toBe(0);
    expect(minutesAt(64 * 1.2, 64)).toBe(60); // 72 minutes -> the 60 slot
    expect(minutesAt(64 * 9.51, 64)).toBe(9 * 60 + 30);
    expect(minutesAt(64 * 99, 64)).toBe(23 * 60 + 30);
  });

  it('turns a click or a drag into a start and end, whichever way it was dragged', () => {
    const day = startOfDay(tuesday);
    const click = slotRange(day, 12 * 60, 12 * 60);
    expect(click.start).toBe(hour(day, 12));
    expect(click.end).toBe(hour(day, 12, 30));
    const down = slotRange(day, 9 * 60, 10 * 60);
    expect(down).toEqual({ start: hour(day, 9), end: hour(day, 10, 30) });
    expect(slotRange(day, 10 * 60, 9 * 60)).toEqual(down);
  });
});

describe('calendar filter', () => {
  const mine = meeting({ organizer: 'me' });
  const accepted = meeting({ myResponse: 'accepted' });
  const tentative = meeting({ myResponse: 'tentative' });
  const declined = meeting({ myResponse: 'declined' });
  const waiting = meeting({});
  const cancelledWaiting = meeting({ cancelled: true });
  const weekly = meeting({ recurrence: { freq: 'weekly' } });

  it('keeps what each filter says', () => {
    const all = [mine, accepted, tentative, declined, waiting, cancelledWaiting, weekly];
    const kept = (f: Parameters<typeof keepMeeting>[1]) =>
      all.filter((m) => keepMeeting(m, f, 'me'));
    expect(kept('all')).toHaveLength(7);
    expect(kept('organizer')).toEqual([mine]);
    expect(kept('accepted')).toEqual([mine, accepted, tentative]);
    expect(kept('pending')).toEqual([waiting, weekly]);
    expect(kept('recurring')).toEqual([weekly]);
  });
});

import { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import type { MeetingOccurrence } from '@officemesh/protocol/ipc';
import { core } from '../state.ts';
import { weekInfoFor, type CalendarFilter, type CalendarViewKind, type WeekInfo } from './grid.ts';

interface CalendarState {
  view: CalendarViewKind;
  /** Any moment in the day, week or month on screen. */
  anchor: number;
  /** The date picker and coming-up list beside the calendar. */
  sidebar: boolean;
  filter: CalendarFilter;
  /** The "Meetings" calendar in My calendars (the only one, for now). */
  showMeetings: boolean;
  setView(view: CalendarViewKind): void;
  goTo(anchor: number): void;
  setSidebar(open: boolean): void;
  setFilter(filter: CalendarFilter): void;
  setShowMeetings(on: boolean): void;
}

/** The calendar's view, date and filters, shared by the calendar and the list beside it. */
export const useCalendar = create<CalendarState>((set) => ({
  view: 'week',
  anchor: Date.now(),
  sidebar: true,
  filter: 'all',
  showMeetings: true,
  setView: (view) => set({ view }),
  goTo: (anchor) => set({ anchor }),
  setSidebar: (sidebar) => set({ sidebar }),
  setFilter: (filter) => set({ filter }),
  setShowMeetings: (showMeetings) => set({ showMeetings }),
}));

/** Meetings between two moments, kept up to date as they are scheduled, changed or answered. */
export function useMeetings(from: number, to: number): MeetingOccurrence[] {
  const [items, setItems] = useState<MeetingOccurrence[]>([]);
  const load = useCallback(() => {
    void core.invoke('meetings.list', { from, to }).then(setItems);
  }, [from, to]);
  useEffect(() => {
    load();
    return core.on('meetings.changed', load);
  }, [load]);
  return items;
}

/** The first day of the week and the days off, from the PC's language and region. */
export function useWeekInfo(): WeekInfo {
  return useMemo(() => weekInfoFor(navigator.language), []);
}

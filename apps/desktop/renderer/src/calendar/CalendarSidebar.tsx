import { useState } from 'react';
import {
  Button,
  Checkbox,
  makeStyles,
  mergeClasses,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ChevronLeft20Regular, ChevronRight20Regular } from '@fluentui/react-icons';
import { meetingWhen } from '../chat/MeetingCards.tsx';
import { strings } from '../strings.ts';
import { useCalendar, useMeetings, useWeekInfo } from './calendarStore.ts';
import {
  addDays,
  addMonths,
  daysFor,
  monthGrid,
  sameDay,
  startOfDay,
  startOfMonth,
} from './grid.ts';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
    padding: `0 ${tokens.spacingHorizontalL} ${tokens.spacingVerticalL}`,
    overflowY: 'auto',
    minHeight: 0,
  },
  mini: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS },
  miniHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', rowGap: '2px' },
  weekday: {
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    padding: '4px 0',
  },
  cell: {
    height: '30px',
    border: 'none',
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    display: 'grid',
    placeItems: 'center',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  outside: { color: tokens.colorNeutralForeground4 },
  inWeek: { background: tokens.colorBrandBackground2 },
  today: {
    '> span': {
      background: tokens.colorBrandBackground,
      color: tokens.colorNeutralForegroundOnBrand,
    },
  },
  dot: {
    width: '26px',
    height: '26px',
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
  },
  section: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS },
  upcoming: {
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  muted: { color: tokens.colorNeutralForeground3 },
});

/**
 * A month to look at and pick a day from. The selected week is tinted, as in Outlook and
 * Teams. Give it `key={startOfMonth(anchor)}` so it follows the calendar to a new month.
 */
export function MiniMonth({
  anchor,
  selected,
  onPick,
}: {
  anchor: number;
  selected: number[];
  onPick: (day: number) => void;
}) {
  const s = useStyles();
  const wk = useWeekInfo();
  const [offset, setOffset] = useState(0);
  // Computed once per mount: "today" does not change while a date picker is open.
  const [today] = useState(() => startOfDay(Date.now()));
  const shown = addMonths(startOfMonth(anchor), offset);
  const days = monthGrid(shown, wk);
  const month = new Date(shown).getMonth();
  const label = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
    shown,
  );
  const weekdays = days
    .slice(0, 7)
    .map((d) => new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(d));
  const selectedSet = new Set(selected.map(startOfDay));
  return (
    <div className={s.mini} data-testid="mini-month">
      <div className={s.miniHead}>
        <Text weight="semibold">{label}</Text>
        <span>
          <Button
            appearance="subtle"
            size="small"
            icon={<ChevronLeft20Regular />}
            aria-label={strings.calendar.previous}
            onClick={() => setOffset((o) => o - 1)}
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<ChevronRight20Regular />}
            aria-label={strings.calendar.next}
            onClick={() => setOffset((o) => o + 1)}
          />
        </span>
      </div>
      <div className={s.grid}>
        {weekdays.map((w, i) => (
          <span key={i} className={s.weekday} aria-hidden>
            {w}
          </span>
        ))}
        {days.map((d) => (
          <button
            key={d}
            type="button"
            className={mergeClasses(
              s.cell,
              new Date(d).getMonth() !== month && s.outside,
              selectedSet.has(d) && s.inWeek,
              d === today && s.today,
            )}
            onClick={() => onPick(d)}
            aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(d)}
            aria-current={d === today ? 'date' : undefined}
            data-testid="mini-day"
            data-date={d}
          >
            <span className={s.dot}>{new Date(d).getDate()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The list beside the calendar: a date picker, My calendars, and what is coming up. */
export function CalendarSidebar() {
  const s = useStyles();
  const wk = useWeekInfo();
  const { view, anchor, showMeetings, goTo, setShowMeetings } = useCalendar();
  const [now] = useState(() => Date.now());
  const upcoming = useMeetings(now - 60 * 60 * 1000, now + 7 * 24 * 60 * 60 * 1000).filter(
    (m) => m.end > now && !m.cancelled,
  );
  const shownDays = view === 'month' ? [] : daysFor(view, anchor, wk);
  const week = view === 'day' ? [startOfDay(anchor)] : shownDays.length ? shownDays : [];
  return (
    <div className={s.root} data-testid="upcoming">
      <MiniMonth
        key={startOfMonth(anchor)}
        anchor={anchor}
        selected={view === 'month' ? [startOfDay(anchor)] : week}
        onPick={(d) => goTo(addDays(d, 0))}
      />
      <div className={s.section}>
        <Text weight="semibold">{strings.calendar.myCalendars}</Text>
        <Checkbox
          checked={showMeetings}
          onChange={(_e, d) => setShowMeetings(d.checked === true)}
          label={strings.calendar.meetingsCalendar}
          data-testid="calendar-show-meetings"
        />
      </div>
      <div className={s.section}>
        <Text weight="semibold">{strings.calendar.upcoming}</Text>
        {upcoming.length === 0 && (
          <Text size={200} className={s.muted}>
            {strings.calendar.none}
          </Text>
        )}
        {upcoming.map((m) => (
          <button
            key={`${m.convId}:${m.target.seq}:${m.start}`}
            type="button"
            className={s.upcoming}
            onClick={() => goTo(m.start)}
            data-testid="upcoming-meeting"
          >
            <Text weight="semibold" block>
              {m.title}
            </Text>
            <Text size={200} className={s.muted}>
              {meetingWhen(m.start, m.end, 'none')}
              {sameDay(m.start, now) && m.live ? ` · ${strings.calendar.inProgress}` : ''}
            </Text>
          </button>
        ))}
      </div>
    </div>
  );
}

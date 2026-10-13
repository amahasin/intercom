import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  makeStyles,
  Menu,
  MenuButton,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  mergeClasses,
  Option,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  SplitButton,
  Text,
  Textarea,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  CalendarAdd20Regular,
  CalendarLtr20Regular,
  CalendarToday20Regular,
  ChevronDown20Regular,
  ChevronLeft20Regular,
  ChevronRight20Regular,
  Filter20Regular,
  PanelLeft20Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import type { Recurrence } from '@officemesh/protocol';
import type { MeetingOccurrence } from '@officemesh/protocol/ipc';
import { meetNow, useCall } from '../calls/engine.ts';
import { meetingWhen } from '../chat/MeetingCards.tsx';
import { PeoplePicker } from '../people/PeoplePicker.tsx';
import { core, displayName, selectConversation, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { useCalendar, useMeetings, useWeekInfo } from './calendarStore.ts';
import { MiniMonth } from './CalendarSidebar.tsx';
import {
  DAY_MS,
  daysFor,
  keepMeeting,
  layoutDay,
  minutesAt,
  monthGrid,
  rangeFor,
  rangeLabel,
  sameDay,
  slotRange,
  startOfDay,
  startOfMonth,
  step,
  type CalendarFilter,
  type CalendarViewKind,
  type Placed,
  type WeekInfo,
} from './grid.ts';

const HOUR_PX = 64;
const WORK_START = 8;
const WORK_END = 17;
const GUTTER_PX = 64;

const useStyles = makeStyles({
  root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 },
  bar: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexWrap: 'wrap',
    rowGap: tokens.spacingVerticalXS,
  },
  grow: { flex: 1 },
  label: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase400 },
  scroller: { flex: 1, overflowY: 'auto', minHeight: 0, position: 'relative' },
  headRow: {
    display: 'flex',
    position: 'sticky',
    top: 0,
    zIndex: 4,
    background: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  gutterHead: { width: `${GUTTER_PX}px`, flexShrink: 0 },
  dayHead: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'baseline',
    columnGap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    borderTop: '3px solid transparent',
    cursor: 'pointer',
  },
  dayNum: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightRegular },
  dayName: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  todayHead: {
    borderTop: `3px solid ${tokens.colorBrandStroke1}`,
    '& > span:first-child': {
      color: tokens.colorBrandForeground1,
      fontWeight: tokens.fontWeightSemibold,
    },
  },
  offHead: { background: tokens.colorNeutralBackground2 },
  body: { display: 'flex', position: 'relative' },
  gutter: { width: `${GUTTER_PX}px`, flexShrink: 0, position: 'relative' },
  hourLabel: {
    position: 'absolute',
    right: tokens.spacingHorizontalS,
    transform: 'translateY(-50%)',
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    background: tokens.colorNeutralBackground1,
    padding: '0 2px',
  },
  column: {
    flex: 1,
    minWidth: 0,
    position: 'relative',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundImage: `repeating-linear-gradient(to bottom, ${tokens.colorNeutralStroke2} 0, ${tokens.colorNeutralStroke2} 1px, transparent 1px, transparent ${HOUR_PX}px), repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX / 2 - 1}px, ${tokens.colorNeutralStroke3} ${HOUR_PX / 2 - 1}px, ${tokens.colorNeutralStroke3} ${HOUR_PX / 2}px, transparent ${HOUR_PX / 2}px, transparent ${HOUR_PX}px)`,
    userSelect: 'none',
    cursor: 'cell',
  },
  off: {
    position: 'absolute',
    left: 0,
    right: 0,
    background: tokens.colorNeutralBackground3,
    opacity: 0.55,
    pointerEvents: 'none',
  },
  event: {
    position: 'absolute',
    padding: '2px 6px',
    borderRadius: tokens.borderRadiusMedium,
    borderLeft: `4px solid ${tokens.colorBrandStroke1}`,
    background: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textAlign: 'left',
    cursor: 'pointer',
    border: 'none',
    fontSize: tokens.fontSizeBase200,
    boxSizing: 'border-box',
    boxShadow: `0 0 0 1px ${tokens.colorNeutralBackground1}`,
    ':hover': { background: tokens.colorBrandBackground2Hover },
  },
  cancelled: { textDecoration: 'line-through', opacity: 0.6 },
  live: { borderLeft: `4px solid ${tokens.colorPaletteGreenBorder2}` },
  pending: {
    borderLeftColor: tokens.colorNeutralStroke1,
    background: tokens.colorNeutralBackground3,
  },
  selection: {
    position: 'absolute',
    left: '2px',
    right: '2px',
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    padding: '2px 6px',
    fontSize: tokens.fontSizeBase200,
    pointerEvents: 'none',
    zIndex: 2,
    overflow: 'hidden',
  },
  nowLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 0,
    borderTop: `2px solid ${tokens.colorBrandForeground1}`,
    zIndex: 3,
    pointerEvents: 'none',
  },
  nowDash: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 0,
    borderTop: `1px dashed ${tokens.colorBrandStroke2}`,
    zIndex: 1,
    pointerEvents: 'none',
  },
  nowDot: {
    position: 'absolute',
    left: '-6px',
    top: '-6px',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: tokens.colorBrandForeground1,
  },
  details: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    maxWidth: '340px',
  },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  month: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 },
  monthHead: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  monthHeadCell: {
    padding: tokens.spacingVerticalS,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  monthBody: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
    gridTemplateRows: 'repeat(6, minmax(0, 1fr))',
  },
  monthCell: {
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: '2px 4px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: '2px',
    minHeight: 0,
    overflow: 'hidden',
    cursor: 'cell',
  },
  monthOutside: {
    background: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
  },
  monthDay: {
    alignSelf: 'flex-start',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    width: '26px',
    height: '26px',
    borderRadius: '50%',
    color: 'inherit',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  monthToday: {
    background: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  chip: {
    border: 'none',
    background: tokens.colorBrandBackground2,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: '0 4px',
    textAlign: 'left',
    fontSize: tokens.fontSizeBase100,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
  },
  more: {
    border: 'none',
    background: 'transparent',
    color: tokens.colorBrandForegroundLink,
    textAlign: 'left',
    fontSize: tokens.fontSizeBase100,
    cursor: 'pointer',
    padding: '0 4px',
  },
  fields: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  fieldRow: { display: 'flex', columnGap: tokens.spacingHorizontalS },
});

const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const hourOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

/** Re-renders every minute, so the current-time line and "today" stay right. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function MeetingDetails({ o }: { o: MeetingOccurrence }) {
  const s = useStyles();
  const selfId = useApp((st) => st.identity?.userId);
  const inCall = useCall((st) => st.call !== null);
  const organizer = o.organizer === selfId;
  return (
    <div className={s.details} data-testid="meeting-details">
      <Text weight="semibold" size={400}>
        {o.title}
      </Text>
      <Text size={200}>{meetingWhen(o.start, o.end, o.recurrence.freq)}</Text>
      <Text size={200}>{strings.meetings.organizer(displayName(o.organizer))}</Text>
      <Text size={200}>
        {o.attendees
          .map((u) => {
            const r = o.rsvps.find((x) => x.userId === u)?.response;
            return `${displayName(u)}${r ? ` (${strings.meetings.responses[r]})` : ''}`;
          })
          .join(', ')}
      </Text>
      {o.notes && <Text size={200}>{o.notes}</Text>}
      {o.cancelled ? (
        <Text weight="semibold">{strings.meetings.cancelled}</Text>
      ) : (
        <>
          <div className={s.row}>
            <Button
              appearance="primary"
              disabled={inCall}
              onClick={() => void meetNow(o.convId, 'video', o.target)}
              data-testid="calendar-join"
            >
              {strings.meetings.join}
            </Button>
            <Button onClick={() => void selectConversation(o.convId)}>{strings.inCall.chat}</Button>
            <Button
              onClick={() =>
                void core.invoke('meetings.exportIcs', { convId: o.convId, target: o.target })
              }
            >
              .ics
            </Button>
          </div>
          {!organizer && (
            <div className={s.row}>
              {(['accepted', 'tentative', 'declined'] as const).map((r) => (
                <Button
                  key={r}
                  size="small"
                  appearance={o.myResponse === r ? 'primary' : 'secondary'}
                  onClick={() =>
                    void core.invoke('meetings.rsvp', {
                      convId: o.convId,
                      target: o.target,
                      response: r,
                    })
                  }
                >
                  {strings.meetings.responses[r]}
                </Button>
              ))}
            </div>
          )}
          {organizer && (
            <div className={s.row}>
              {o.recurrence.freq !== 'none' && (
                <Button
                  size="small"
                  onClick={() =>
                    void core.invoke('meetings.cancel', {
                      convId: o.convId,
                      target: o.target,
                      occurrence: o.start,
                    })
                  }
                >
                  {strings.meetings.cancelOccurrence}
                </Button>
              )}
              <Button
                size="small"
                onClick={() =>
                  void core.invoke('meetings.cancel', { convId: o.convId, target: o.target })
                }
              >
                {strings.meetings.cancelMeeting}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const keyOf = (m: MeetingOccurrence) => `${m.convId}:${m.target.author}:${m.target.seq}:${m.start}`;

/** A meeting in a day column, beside any it overlaps. */
function EventBlock({ p, selfId }: { p: Placed; selfId: string | undefined }) {
  const s = useStyles();
  const { m } = p;
  const pending = m.organizer !== selfId && m.myResponse === undefined && !m.cancelled;
  return (
    <Popover withArrow positioning="after">
      <PopoverTrigger disableButtonEnhancement>
        <button
          type="button"
          className={mergeClasses(
            s.event,
            m.cancelled && s.cancelled,
            m.live && s.live,
            pending && s.pending,
          )}
          style={{
            top: p.top * HOUR_PX,
            height: p.height * HOUR_PX - 2,
            left: `${(p.col / p.cols) * 100}%`,
            width: `${100 / p.cols}%`,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          data-testid="calendar-event"
          data-title={m.title}
        >
          <b>{m.title}</b>
          {p.height * HOUR_PX > 40 && (
            <>
              <br />
              {timeOnly.format(m.start)} – {timeOnly.format(m.end)}
            </>
          )}
          {p.height * HOUR_PX > 58 && m.conversation && (
            <>
              <br />
              {m.conversation}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverSurface>
        <MeetingDetails o={m} />
      </PopoverSurface>
    </Popover>
  );
}

interface Selection {
  day: number;
  a: number;
  b: number;
}

/** Day, work-week and week views: hours down the side, a column per day. */
function TimeGrid({
  days,
  meetings,
  now,
  wk,
  selection,
  onSelect,
  onCreate,
  onGoToDay,
}: {
  days: number[];
  meetings: MeetingOccurrence[];
  now: number;
  wk: WeekInfo;
  selection: Selection | undefined;
  onSelect: (s: Selection | undefined) => void;
  onCreate: (range: { start: number; end: number }) => void;
  onGoToDay: (day: number) => void;
}) {
  const s = useStyles();
  const selfId = useApp((st) => st.identity?.userId);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ day: number; a: number; moved: boolean; el: HTMLElement } | null>(null);
  const ctxAt = useRef<{ day: number; minutes: number } | null>(null);
  const today = startOfDay(now);
  const nowHours = (now - today) / 3_600_000;

  // Start with the working day (or, if today is shown, a little before now) in view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const focus = days.includes(today) ? Math.max(0, nowHours - 2) : WORK_START - 0.5;
    el.scrollTop = focus * HOUR_PX;
    // Only when the set of days changes (not every minute).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length, days[0]]);

  const startDrag = (e: React.MouseEvent<HTMLDivElement>, day: number) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const a = minutesAt(e.clientY - el.getBoundingClientRect().top, HOUR_PX);
    drag.current = { day, a, moved: false, el };
    onSelect({ day, a, b: a });
    const move = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const b = minutesAt(ev.clientY - d.el.getBoundingClientRect().top, HOUR_PX);
      if (b !== d.a) d.moved = true;
      onSelect({ day: d.day, a: d.a, b });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const d = drag.current;
      drag.current = null;
      // Dragging across slots picks the time; the dialog opens on release.
      if (d?.moved)
        onCreate(
          slotRange(d.day, d.a, minutesAt(ev.clientY - d.el.getBoundingClientRect().top, HOUR_PX)),
        );
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className={s.scroller} ref={scroller} data-testid="calendar-scroller">
      <div className={s.headRow}>
        <div className={s.gutterHead} />
        {days.map((d) => {
          const date = new Date(d);
          return (
            <div
              key={d}
              className={mergeClasses(
                s.dayHead,
                d === today && s.todayHead,
                wk.weekend.includes(date.getDay()) && s.offHead,
              )}
              onClick={() => onGoToDay(d)}
              data-testid="calendar-day-head"
              data-date={d}
              data-today={d === today}
            >
              <span className={s.dayNum}>{date.getDate()}</span>
              <span className={s.dayName}>
                {new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(d)}
              </span>
            </div>
          );
        })}
      </div>
      <div className={s.body} style={{ height: 24 * HOUR_PX }}>
        <div className={s.gutter}>
          {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
            <span key={h} className={s.hourLabel} style={{ top: h * HOUR_PX }}>
              {hourOnly.format(new Date(2000, 0, 1, h))}
            </span>
          ))}
        </div>
        {days.map((d) => {
          const weekend = wk.weekend.includes(new Date(d).getDay());
          const placed = layoutDay(meetings, d);
          const sel = selection && selection.day === d ? selection : undefined;
          const selRange = sel ? slotRange(d, sel.a, sel.b) : undefined;
          return (
            <Menu key={d} openOnContext>
              <MenuTrigger disableButtonEnhancement>
                <div
                  className={s.column}
                  onMouseDown={(e) => startDrag(e, d)}
                  onDoubleClick={(e) => {
                    const minutes = minutesAt(
                      e.clientY - e.currentTarget.getBoundingClientRect().top,
                      HOUR_PX,
                    );
                    onCreate(slotRange(d, minutes, minutes));
                  }}
                  onContextMenu={(e) => {
                    const minutes = minutesAt(
                      e.clientY - e.currentTarget.getBoundingClientRect().top,
                      HOUR_PX,
                    );
                    ctxAt.current = { day: d, minutes };
                    onSelect({ day: d, a: minutes, b: minutes });
                  }}
                  data-testid="calendar-column"
                  data-date={d}
                >
                  {weekend ? (
                    <div className={s.off} style={{ top: 0, bottom: 0 }} />
                  ) : (
                    <>
                      <div className={s.off} style={{ top: 0, height: WORK_START * HOUR_PX }} />
                      <div className={s.off} style={{ top: WORK_END * HOUR_PX, bottom: 0 }} />
                    </>
                  )}
                  {placed.map((p) => (
                    <EventBlock key={keyOf(p.m)} p={p} selfId={selfId} />
                  ))}
                  {selRange && sel && (
                    <div
                      className={s.selection}
                      style={{
                        top: (Math.min(sel.a, sel.b) / 60) * HOUR_PX,
                        height: ((Math.abs(sel.b - sel.a) + 30) / 60) * HOUR_PX - 2,
                      }}
                      data-testid="calendar-selection"
                    >
                      {timeOnly.format(selRange.start)} – {timeOnly.format(selRange.end)}
                    </div>
                  )}
                  {d === today ? (
                    <div
                      className={s.nowLine}
                      style={{ top: nowHours * HOUR_PX }}
                      data-testid="now-line"
                    >
                      <span className={s.nowDot} />
                    </div>
                  ) : (
                    days.includes(today) && (
                      <div className={s.nowDash} style={{ top: nowHours * HOUR_PX }} />
                    )
                  )}
                </div>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem
                    onClick={() => {
                      const at = ctxAt.current;
                      if (at) onCreate(slotRange(at.day, at.minutes, at.minutes));
                    }}
                    data-testid="calendar-ctx-new"
                  >
                    {strings.calendar.newMeetingHere}
                  </MenuItem>
                  <MenuItem
                    onClick={() => useCalendar.getState().goTo(Date.now())}
                    data-testid="calendar-ctx-today"
                  >
                    {strings.calendar.goToToday}
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          );
        })}
      </div>
    </div>
  );
}

/** Month view: a grid of days with their meetings. */
function MonthGrid({
  anchor,
  meetings,
  now,
  wk,
  onCreate,
  onGoToDay,
}: {
  anchor: number;
  meetings: MeetingOccurrence[];
  now: number;
  wk: WeekInfo;
  onCreate: (range: { start: number; end: number }) => void;
  onGoToDay: (day: number) => void;
}) {
  const s = useStyles();
  const days = monthGrid(anchor, wk);
  const month = new Date(startOfMonth(anchor)).getMonth();
  const today = startOfDay(now);
  const ctxDay = useRef(today);
  return (
    <div className={s.month} data-testid="calendar-month">
      <div className={s.monthHead}>
        {days.slice(0, 7).map((d) => (
          <div key={d} className={s.monthHeadCell}>
            {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d)}
          </div>
        ))}
      </div>
      <div className={s.monthBody}>
        {days.map((d) => {
          const own = meetings.filter((m) => m.start < d + DAY_MS && m.end > d);
          const shown = own.slice(0, 3);
          const date = new Date(d);
          return (
            <Menu key={d} openOnContext>
              <MenuTrigger disableButtonEnhancement>
                <div
                  className={mergeClasses(s.monthCell, date.getMonth() !== month && s.monthOutside)}
                  onDoubleClick={() => onCreate(defaultSlot(d, now))}
                  onContextMenu={() => {
                    ctxDay.current = d;
                  }}
                  data-testid="calendar-month-cell"
                  data-date={d}
                >
                  <button
                    type="button"
                    className={mergeClasses(s.monthDay, d === today && s.monthToday)}
                    onClick={() => onGoToDay(d)}
                    aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(d)}
                  >
                    {date.getDate()}
                  </button>
                  {shown.map((m) => (
                    <Popover key={keyOf(m)} withArrow positioning="after">
                      <PopoverTrigger disableButtonEnhancement>
                        <button
                          type="button"
                          className={mergeClasses(s.chip, m.cancelled && s.cancelled)}
                          data-testid="calendar-event"
                          data-title={m.title}
                        >
                          {timeOnly.format(m.start)} {m.title}
                        </button>
                      </PopoverTrigger>
                      <PopoverSurface>
                        <MeetingDetails o={m} />
                      </PopoverSurface>
                    </Popover>
                  ))}
                  {own.length > shown.length && (
                    <button type="button" className={s.more} onClick={() => onGoToDay(d)}>
                      {strings.calendar.more(own.length - shown.length)}
                    </button>
                  )}
                </div>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem onClick={() => onCreate(defaultSlot(ctxDay.current, now))}>
                    {strings.calendar.newMeetingHere}
                  </MenuItem>
                  <MenuItem onClick={() => useCalendar.getState().goTo(Date.now())}>
                    {strings.calendar.goToToday}
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          );
        })}
      </div>
    </div>
  );
}

/** A half hour on `day`: the next half hour if it is today, else 9:00. */
function defaultSlot(day: number, now: number): { start: number; end: number } {
  if (sameDay(day, now)) {
    const next = Math.ceil((now + 1) / (30 * 60_000)) * 30 * 60_000;
    return { start: next, end: next + 30 * 60_000 };
  }
  return slotRange(day, 9 * 60, 9 * 60);
}

export function CalendarView() {
  const s = useStyles();
  const wk = useWeekInfo();
  const selfId = useApp((st) => st.identity?.userId) ?? '';
  const { view, anchor, filter, sidebar, showMeetings } = useCalendar();
  const setView = useCalendar((st) => st.setView);
  const goTo = useCalendar((st) => st.goTo);
  const now = useNow();
  const [selection, setSelection] = useState<Selection | undefined>();
  const [creating, setCreating] = useState<{ start: number; end: number } | 'blank' | undefined>();
  const [meetNowOpen, setMeetNowOpen] = useState(false);

  const [from, to] = rangeFor(view, anchor, wk);
  const meetings = useMeetings(from, to).filter(
    (m) => showMeetings && keepMeeting(m, filter, selfId),
  );
  const days = view === 'month' ? [] : daysFor(view, anchor, wk);
  const label = rangeLabel(view, anchor, days);

  const openCreate = (range: { start: number; end: number } | 'blank') => setCreating(range);
  const goToDay = (day: number) => {
    goTo(day);
    setView('day');
  };

  // Escape clears the highlighted time slot.
  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  return (
    <section className={s.root} data-testid="calendar">
      <div className={s.bar}>
        <Tooltip content={strings.calendar.toggleSidebar} relationship="label">
          <Button
            appearance="subtle"
            icon={<PanelLeft20Regular />}
            aria-pressed={sidebar}
            onClick={() => useCalendar.getState().setSidebar(!sidebar)}
            data-testid="calendar-sidebar-toggle"
          />
        </Tooltip>
        <Button
          icon={<CalendarToday20Regular />}
          onClick={() => goTo(Date.now())}
          data-testid="calendar-today"
        >
          {strings.calendar.today}
        </Button>
        <Button
          appearance="subtle"
          icon={<ChevronLeft20Regular />}
          aria-label={strings.calendar.previous}
          onClick={() => goTo(step(view, anchor, -1))}
          data-testid="calendar-prev"
        />
        <Button
          appearance="subtle"
          icon={<ChevronRight20Regular />}
          aria-label={strings.calendar.next}
          onClick={() => goTo(step(view, anchor, 1))}
          data-testid="calendar-next"
        />
        <Popover positioning="below-start">
          <PopoverTrigger disableButtonEnhancement>
            <Button
              appearance="subtle"
              iconPosition="after"
              icon={<ChevronDown20Regular />}
              aria-label={strings.calendar.jumpTo}
              data-testid="calendar-range"
            >
              <span className={s.label}>{label}</span>
            </Button>
          </PopoverTrigger>
          <PopoverSurface>
            <div style={{ width: 260 }}>
              <MiniMonth
                key={startOfMonth(anchor)}
                anchor={anchor}
                selected={view === 'month' ? [startOfDay(anchor)] : days}
                onPick={goTo}
              />
            </div>
          </PopoverSurface>
        </Popover>
        <span className={s.grow} />
        <Menu
          checkedValues={{ view: [view] }}
          onCheckedValueChange={(_e, d) => setView(d.checkedItems[0] as CalendarViewKind)}
        >
          <MenuTrigger disableButtonEnhancement>
            <MenuButton
              icon={<CalendarLtr20Regular />}
              aria-label={strings.calendar.view}
              data-testid="calendar-view-menu"
            >
              {strings.calendar.views[view]}
            </MenuButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {(['day', 'workweek', 'week', 'month'] as const).map((v) => (
                <MenuItemRadio key={v} name="view" value={v} data-testid={`calendar-view-${v}`}>
                  {strings.calendar.views[v]}
                </MenuItemRadio>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <Menu
          checkedValues={{ filter: [filter] }}
          onCheckedValueChange={(_e, d) =>
            useCalendar.getState().setFilter(d.checkedItems[0] as CalendarFilter)
          }
        >
          <MenuTrigger disableButtonEnhancement>
            <MenuButton
              icon={<Filter20Regular />}
              data-testid="calendar-filter-menu"
              data-filtered={filter !== 'all'}
            >
              {filter === 'all' ? strings.calendar.filter : strings.calendar.filterApplied}
            </MenuButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {(['all', 'organizer', 'accepted', 'pending', 'recurring'] as const).map((f) => (
                <MenuItemRadio key={f} name="filter" value={f} data-testid={`calendar-filter-${f}`}>
                  {strings.calendar.filters[f]}
                </MenuItemRadio>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <Button
          appearance="subtle"
          icon={<Video20Regular />}
          onClick={() => setMeetNowOpen(true)}
          data-testid="calendar-meet-now"
        >
          {strings.calendar.meetNow}
        </Button>
        <Menu positioning="below-end">
          <MenuTrigger disableButtonEnhancement>
            {(triggerProps) => (
              <SplitButton
                appearance="primary"
                icon={<CalendarAdd20Regular />}
                menuButton={triggerProps}
                primaryActionButton={{
                  onClick: () => openCreate('blank'),
                  ...({ 'data-testid': 'meeting-new' } as Record<string, string>),
                }}
              >
                {strings.calendar.newMeeting}
              </SplitButton>
            )}
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<CalendarAdd20Regular />} onClick={() => openCreate('blank')}>
                {strings.calendar.newMeeting}
              </MenuItem>
              <MenuItem icon={<Video20Regular />} onClick={() => setMeetNowOpen(true)}>
                {strings.calendar.meetNow}
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
      {view === 'month' ? (
        <MonthGrid
          anchor={anchor}
          meetings={meetings}
          now={now}
          wk={wk}
          onCreate={openCreate}
          onGoToDay={goToDay}
        />
      ) : (
        <TimeGrid
          days={days}
          meetings={meetings}
          now={now}
          wk={wk}
          selection={selection}
          onSelect={setSelection}
          onCreate={openCreate}
          onGoToDay={goToDay}
        />
      )}
      {creating && (
        <NewMeetingDialog
          {...(creating !== 'blank' && { initial: creating })}
          onClose={() => {
            setCreating(undefined);
            setSelection(undefined);
          }}
        />
      )}
      {meetNowOpen && <MeetNowDialog onClose={() => setMeetNowOpen(false)} />}
    </section>
  );
}

function toInputDate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toInputTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fromInputs(date: string, time: string): number {
  const [y, mo, da] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y!, (mo ?? 1) - 1, da, h, mi).getTime();
}

export function NewMeetingDialog({
  onClose,
  convId,
  initial,
}: {
  onClose: () => void;
  convId?: string;
  /** The time slot the user picked on the calendar. */
  initial?: { start: number; end: number };
}) {
  const s = useStyles();
  const [fallback] = useState(() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    const start = d.getTime() + 60 * 60 * 1000;
    return { start, end: start + 30 * 60 * 1000 };
  });
  const slot = initial ?? fallback;
  const conversations = useApp((st) => st.conversations);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(toInputDate(slot.start));
  const [start, setStart] = useState(toInputTime(slot.start));
  const [end, setEnd] = useState(toInputTime(slot.end));
  const [freq, setFreq] = useState<Recurrence['freq']>('none');
  const [until, setUntil] = useState('');
  const [where, setWhere] = useState<string>(convId ?? '');
  const [invitees, setInvitees] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const places = Object.values(conversations).filter(
    (c) => c.active && !c.temporary && (c.kind === 'group' || c.kind === 'channel'),
  );
  const startAt = fromInputs(date, start);
  const endAt = fromInputs(date, end);
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 560 }}>
        <DialogBody>
          <DialogTitle>{strings.meetings.newMeeting}</DialogTitle>
          <DialogContent className={s.fields}>
            <Field label={strings.meetings.title} required>
              <Input
                value={title}
                maxLength={200}
                autoFocus
                onChange={(_e, d) => setTitle(d.value)}
                data-testid="meeting-title"
              />
            </Field>
            <div className={s.fieldRow}>
              <Field label={strings.meetings.date}>
                <Input
                  type="date"
                  value={date}
                  onChange={(_e, d) => setDate(d.value)}
                  data-testid="meeting-date"
                />
              </Field>
              <Field label={strings.meetings.start}>
                <Input
                  type="time"
                  step={900}
                  value={start}
                  onChange={(_e, d) => setStart(d.value)}
                  data-testid="meeting-start"
                />
              </Field>
              <Field
                label={strings.meetings.end}
                validationMessage={endAt <= startAt ? strings.meetings.endBeforeStart : undefined}
              >
                <Input
                  type="time"
                  step={900}
                  value={end}
                  onChange={(_e, d) => setEnd(d.value)}
                  data-testid="meeting-end"
                />
              </Field>
            </div>
            <div className={s.fieldRow}>
              <Field label={strings.meetings.repeat} style={{ flex: 1 }}>
                <Dropdown
                  value={strings.meetings.repeats[freq]}
                  selectedOptions={[freq]}
                  onOptionSelect={(_e, d) =>
                    setFreq((d.optionValue as Recurrence['freq']) ?? 'none')
                  }
                  data-testid="meeting-repeat"
                >
                  {(['none', 'daily', 'weekdays', 'weekly'] as const).map((f) => (
                    <Option key={f} value={f}>
                      {strings.meetings.repeats[f]}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              {freq !== 'none' && (
                <Field label={strings.meetings.until}>
                  <Input type="date" value={until} onChange={(_e, d) => setUntil(d.value)} />
                </Field>
              )}
            </div>
            {!convId && (
              <Field label={strings.meetings.where}>
                <Dropdown
                  value={where ? (conversations[where]?.title ?? '') : strings.meetings.newChat}
                  selectedOptions={[where]}
                  onOptionSelect={(_e, d) => setWhere(d.optionValue ?? '')}
                  data-testid="meeting-where"
                >
                  <Option value="">{strings.meetings.newChat}</Option>
                  {places.map((c) => (
                    <Option key={c.convId} value={c.convId}>
                      {c.title}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            )}
            {!where && (
              <Field label={strings.meetings.invitees}>
                <PeoplePicker selected={invitees} onChange={setInvitees} />
              </Field>
            )}
            <Field label={strings.meetings.notes}>
              <Textarea value={notes} maxLength={4000} onChange={(_e, d) => setNotes(d.value)} />
            </Field>
            {error && <Text>{error}</Text>}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
            <Button
              appearance="primary"
              disabled={!title.trim() || endAt <= startAt || (!where && invitees.length === 0)}
              data-testid="meeting-schedule"
              onClick={async () => {
                try {
                  await core.invoke('meetings.schedule', {
                    title: title.trim(),
                    start: startAt,
                    end: endAt,
                    recurrence: {
                      freq,
                      ...(freq !== 'none' && until && { until: fromInputs(until, '23:59') }),
                    },
                    ...(notes.trim() && { notes: notes.trim() }),
                    ...(where ? { convId: where } : { invitees }),
                  });
                  // Show the meeting: jump the calendar to its day.
                  useCalendar.getState().goTo(startAt);
                  onClose();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              {strings.meetings.schedule}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Start a meeting right now in a group chat or channel, or with people picked here. */
export function MeetNowDialog({ onClose }: { onClose: () => void }) {
  const conversations = useApp((st) => st.conversations);
  const inCall = useCall((st) => st.call !== null);
  const [where, setWhere] = useState('');
  const [invitees, setInvitees] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const places = Object.values(conversations).filter(
    (c) => c.active && !c.temporary && (c.kind === 'group' || c.kind === 'channel'),
  );
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 520 }}>
        <DialogBody>
          <DialogTitle>{strings.calendar.meetNowTitle}</DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', rowGap: 10 }}>
            <Field label={strings.calendar.meetNowWith}>
              <Dropdown
                value={
                  where ? (conversations[where]?.title ?? '') : strings.calendar.meetNowNewGroup
                }
                selectedOptions={[where]}
                onOptionSelect={(_e, d) => setWhere(d.optionValue ?? '')}
                data-testid="meetnow-where"
              >
                <Option value="">{strings.calendar.meetNowNewGroup}</Option>
                {places.map((c) => (
                  <Option key={c.convId} value={c.convId}>
                    {c.title}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            {!where && (
              <Field label={strings.meetings.invitees}>
                <PeoplePicker selected={invitees} onChange={setInvitees} />
              </Field>
            )}
            {error && <Text>{error}</Text>}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
            <Button
              appearance="primary"
              disabled={inCall || starting || (!where && invitees.length === 0)}
              data-testid="meetnow-start"
              onClick={async () => {
                setStarting(true);
                try {
                  const convId =
                    where ||
                    (await core.invoke('groups.create', { members: invitees, title: 'Meeting' }))
                      .convId;
                  onClose();
                  await meetNow(convId, 'video');
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                  setStarting(false);
                }
              }}
            >
              {strings.calendar.meetNowStart}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

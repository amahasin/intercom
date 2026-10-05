import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  mergeClasses,
  Option,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Tab,
  TabList,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { Add20Regular, ChevronLeft20Regular, ChevronRight20Regular } from '@fluentui/react-icons';
import type { Recurrence } from '@officemesh/protocol';
import type { MeetingOccurrence } from '@officemesh/protocol/ipc';
import { meetNow, useCall } from '../calls/engine.ts';
import { meetingWhen } from '../chat/MeetingCards.tsx';
import { PeoplePicker } from '../people/PeoplePicker.tsx';
import { core, displayName, selectConversation, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const HOUR_PX = 48;
const DAY_MS = 24 * 60 * 60 * 1000;

const useStyles = makeStyles({
  root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  bar: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  grow: { flex: 1 },
  head: {
    display: 'flex',
    paddingLeft: '56px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  dayHead: { flex: 1, padding: tokens.spacingVerticalXS, textAlign: 'center' },
  today: { color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  scroller: { flex: 1, overflowY: 'auto', minHeight: 0 },
  grid: { display: 'flex', position: 'relative' },
  hours: { width: '56px', flexShrink: 0 },
  hour: {
    height: `${HOUR_PX}px`,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    textAlign: 'right',
    paddingRight: '6px',
  },
  day: {
    flex: 1,
    position: 'relative',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundImage: `repeating-linear-gradient(to bottom, ${tokens.colorNeutralStroke3} 0, ${tokens.colorNeutralStroke3} 1px, transparent 1px, transparent ${HOUR_PX}px)`,
  },
  event: {
    position: 'absolute',
    left: '3px',
    right: '3px',
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
  },
  cancelled: { textDecoration: 'line-through', opacity: 0.6 },
  live: { borderLeft: `4px solid ${tokens.colorPaletteGreenBorder2}` },
  details: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    maxWidth: '340px',
  },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

type View = 'day' | 'workweek' | 'week';

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(t: number, n: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** The days shown: one, Monday to Friday, or Monday to Sunday around `anchor`. */
function daysOf(view: View, anchor: number): number[] {
  const day = startOfDay(anchor);
  if (view === 'day') return [day];
  const weekday = (new Date(day).getDay() + 6) % 7; // Monday = 0
  const monday = addDays(day, -weekday);
  return Array.from({ length: view === 'week' ? 7 : 5 }, (_, i) => addDays(monday, i));
}

const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
const rangeLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

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

export function CalendarView() {
  const s = useStyles();
  const [view, setView] = useState<View>('workweek');
  const [anchor, setAnchor] = useState(() => Date.now());
  const [creating, setCreating] = useState(false);
  const days = daysOf(view, anchor);
  const from = days[0]!;
  const to = addDays(days.at(-1)!, 1);
  const meetings = useMeetings(from, to);
  const scroller = useRef<HTMLDivElement>(null);
  const [today] = useState(() => startOfDay(Date.now()));
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 8 * HOUR_PX;
  }, []);
  const step = view === 'day' ? 1 : 7;
  return (
    <section className={s.root} data-testid="calendar">
      <div className={s.bar}>
        <Button
          icon={<Add20Regular />}
          appearance="primary"
          onClick={() => setCreating(true)}
          data-testid="meeting-new"
        >
          {strings.meetings.newMeeting}
        </Button>
        <Button onClick={() => setAnchor(Date.now())}>{strings.meetings.today}</Button>
        <Button
          appearance="subtle"
          icon={<ChevronLeft20Regular />}
          aria-label="Previous"
          onClick={() => setAnchor(addDays(anchor, -step))}
        />
        <Button
          appearance="subtle"
          icon={<ChevronRight20Regular />}
          aria-label="Next"
          onClick={() => setAnchor(addDays(anchor, step))}
        />
        <Text weight="semibold">{rangeLabel.format(anchor)}</Text>
        <span className={s.grow} />
        <TabList
          selectedValue={view}
          onTabSelect={(_e, d) => setView(d.value as View)}
          size="small"
        >
          <Tab value="day">{strings.meetings.day}</Tab>
          <Tab value="workweek">{strings.meetings.workWeek}</Tab>
          <Tab value="week">{strings.meetings.week}</Tab>
        </TabList>
      </div>
      <div className={s.head}>
        {days.map((d) => (
          <div key={d} className={mergeClasses(s.dayHead, d === today && s.today)}>
            {dayLabel.format(d)}
          </div>
        ))}
      </div>
      <div className={s.scroller} ref={scroller}>
        <div className={s.grid}>
          <div className={s.hours}>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className={s.hour}>
                {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div key={d} className={s.day} style={{ height: 24 * HOUR_PX }}>
              {meetings
                .filter((m) => m.start < d + DAY_MS && m.end > d)
                .map((m) => {
                  const top = (Math.max(m.start, d) - d) / (60 * 60 * 1000);
                  const height = Math.max(
                    0.4,
                    (Math.min(m.end, d + DAY_MS) - Math.max(m.start, d)) / (60 * 60 * 1000),
                  );
                  return (
                    <Popover
                      key={`${m.convId}:${m.target.author}:${m.target.seq}:${m.start}`}
                      withArrow
                      positioning="after"
                    >
                      <PopoverTrigger disableButtonEnhancement>
                        <button
                          type="button"
                          className={mergeClasses(
                            s.event,
                            m.cancelled && s.cancelled,
                            m.live && s.live,
                          )}
                          style={{ top: top * HOUR_PX, height: height * HOUR_PX - 2 }}
                          data-testid="calendar-event"
                          data-title={m.title}
                        >
                          <b>{m.title}</b>
                          <br />
                          {m.conversation}
                        </button>
                      </PopoverTrigger>
                      <PopoverSurface>
                        <MeetingDetails o={m} />
                      </PopoverSurface>
                    </Popover>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
      {creating && <NewMeetingDialog onClose={() => setCreating(false)} />}
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

export function NewMeetingDialog({ onClose, convId }: { onClose: () => void; convId?: string }) {
  const nextHour = (() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return d.getTime() + 60 * 60 * 1000;
  })();
  const conversations = useApp((st) => st.conversations);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(toInputDate(nextHour));
  const [start, setStart] = useState(toInputTime(nextHour));
  const [end, setEnd] = useState(toInputTime(nextHour + 30 * 60 * 1000));
  const [freq, setFreq] = useState<Recurrence['freq']>('none');
  const [until, setUntil] = useState('');
  const [where, setWhere] = useState<string>(convId ?? '');
  const [invitees, setInvitees] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const places = Object.values(conversations).filter(
    (c) => c.active && (c.kind === 'group' || c.kind === 'channel'),
  );
  const startAt = fromInputs(date, start);
  const endAt = fromInputs(date, end);
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 560 }}>
        <DialogBody>
          <DialogTitle>{strings.meetings.newMeeting}</DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', rowGap: 10 }}>
            <Field label={strings.meetings.title} required>
              <Input
                value={title}
                maxLength={200}
                onChange={(_e, d) => setTitle(d.value)}
                data-testid="meeting-title"
              />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
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
                  value={end}
                  onChange={(_e, d) => setEnd(d.value)}
                  data-testid="meeting-end"
                />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
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

/** The calendar rail's list pane: what is coming up in the next week. */
export function UpcomingMeetings() {
  const [now] = useState(() => Date.now());
  const meetings = useMeetings(now - 60 * 60 * 1000, now + 7 * DAY_MS).filter(
    (m) => m.end > now && !m.cancelled,
  );
  const [creating, setCreating] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        rowGap: 8,
        padding: '0 16px',
        overflowY: 'auto',
      }}
      data-testid="upcoming"
    >
      <Button icon={<Add20Regular />} onClick={() => setCreating(true)}>
        {strings.meetings.newMeeting}
      </Button>
      <Text weight="semibold">{strings.meetings.upcoming}</Text>
      {meetings.length === 0 && <Text size={200}>{strings.meetings.none}</Text>}
      {meetings.map((m) => (
        <Button
          key={`${m.convId}:${m.target.seq}:${m.start}`}
          appearance="subtle"
          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
          onClick={() => void selectConversation(m.convId)}
          data-testid="upcoming-meeting"
        >
          <span>
            <b>{m.title}</b>
            <br />
            {meetingWhen(m.start, m.end, 'none')}
          </span>
        </Button>
      ))}
      {creating && <NewMeetingDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

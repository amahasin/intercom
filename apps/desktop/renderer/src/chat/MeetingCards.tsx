import {
  Badge,
  Button,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  CalendarLtr20Regular,
  MoreHorizontal16Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import type { MessageView } from '@officemesh/protocol/ipc';
import { joinMeeting, meetNow, useCall } from '../calls/engine.ts';
import { core, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    width: '340px',
    maxWidth: '100%',
    padding: tokens.spacingHorizontalS,
    borderLeft: `4px solid ${tokens.colorBrandStroke1}`,
    background: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  muted: { color: tokens.colorNeutralForeground3 },
});

const dateTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Tue 7 Oct, 10:00 – 11:00 · Every week" */
export function meetingWhen(start: number, end: number, freq: string): string {
  const repeat = freq === 'none' ? '' : ` · ${strings.meetings.repeats[freq as 'daily']}`;
  return `${dateTime.format(start)} – ${timeOnly.format(end)}${repeat}`;
}

export function MeetingCard({ message: m }: { message: MessageView }) {
  const s = useStyles();
  const meeting = m.meeting!;
  const selfId = useApp((st) => st.identity?.userId);
  const inCall = useCall((st) => st.call !== null);
  const organizer = m.author === selfId;
  const target = { author: m.author, seq: m.seq };
  const counts = { accepted: 0, tentative: 0, declined: 0 };
  for (const r of meeting.rsvps) counts[r.response]++;
  const rsvp = (response: 'accepted' | 'tentative' | 'declined') =>
    void core.invoke('meetings.rsvp', { convId: m.convId, target, response });
  return (
    <div className={s.card} data-testid="meeting-card" data-cancelled={meeting.cancelled}>
      <div className={s.row}>
        <CalendarLtr20Regular />
        <Text weight="semibold">{meeting.title}</Text>
        {meeting.cancelled && <Badge color="danger">{strings.meetings.cancelled}</Badge>}
      </div>
      <Text size={200}>{meetingWhen(meeting.start, meeting.end, meeting.recurrence.freq)}</Text>
      <Text size={200} className={s.muted}>
        {strings.meetings.organizer(displayName(m.author))}
        {` · ${counts.accepted} ${strings.meetings.responses.accepted.toLowerCase()}`}
        {counts.tentative
          ? ` · ${counts.tentative} ${strings.meetings.responses.tentative.toLowerCase()}`
          : ''}
        {counts.declined
          ? ` · ${counts.declined} ${strings.meetings.responses.declined.toLowerCase()}`
          : ''}
      </Text>
      {meeting.notes && <Text size={200}>{meeting.notes}</Text>}
      {!meeting.cancelled && (
        <div className={s.row}>
          <Button
            size="small"
            appearance="primary"
            icon={<Video20Regular />}
            disabled={inCall}
            onClick={() => void meetNow(m.convId, 'video', target)}
            data-testid="meeting-join"
          >
            {strings.meetings.join}
          </Button>
          {!organizer &&
            (['accepted', 'tentative', 'declined'] as const).map((r) => (
              <Button
                key={r}
                size="small"
                appearance={meeting.myResponse === r ? 'primary' : 'secondary'}
                onClick={() => rsvp(r)}
                data-testid={`rsvp-${r}`}
              >
                {
                  strings.meetings[
                    r === 'accepted' ? 'accept' : r === 'tentative' ? 'tentative' : 'decline'
                  ]
                }
              </Button>
            ))}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button
                size="small"
                appearance="subtle"
                icon={<MoreHorizontal16Regular />}
                aria-label={strings.inCall.more}
              />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem
                  onClick={() =>
                    void core.invoke('meetings.exportIcs', { convId: m.convId, target })
                  }
                  data-testid="meeting-ics"
                >
                  {strings.meetings.exportIcs}
                </MenuItem>
                {organizer && (
                  <MenuItem
                    onClick={() =>
                      void core.invoke('meetings.cancel', { convId: m.convId, target })
                    }
                    data-testid="meeting-cancel"
                  >
                    {strings.meetings.cancelMeeting}
                  </MenuItem>
                )}
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      )}
    </div>
  );
}

/** "Meeting started" with Join, or "Meeting ended". */
export function CallCard({ message: m }: { message: MessageView }) {
  const s = useStyles();
  const card = m.callCard!;
  const current = useCall((st) => st.call?.callId);
  const inThis = current === card.callId;
  return (
    <div className={s.card} data-testid="call-card" data-ended={card.ended}>
      <div className={s.row}>
        <Video20Regular />
        <Text weight="semibold">
          {card.ended ? strings.meetings.ended : strings.meetings.started(displayName(m.author))}
        </Text>
      </div>
      {!card.ended && (
        <div className={s.row}>
          <Button
            size="small"
            appearance="primary"
            disabled={current !== undefined}
            onClick={() => void joinMeeting(m.convId, { author: m.author, seq: m.seq })}
            data-testid="call-card-join"
          >
            {inThis ? strings.meetings.inProgress : strings.meetings.join}
          </Button>
        </div>
      )}
    </div>
  );
}

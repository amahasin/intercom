/**
 * The Calls page, to the right of the dial box (CallsPane): the history, newest first and grouped
 * by day, with filters; and the details of whoever or whatever is selected: quick actions, a quick
 * message and the calls with them.
 */
import { useMemo, useState, type JSX } from 'react';
import {
  Avatar,
  AvatarGroup,
  AvatarGroupItem,
  Button,
  Input,
  makeStyles,
  mergeClasses,
  Text,
  tokens,
  ToggleButton,
  Tooltip,
} from '@fluentui/react-components';
import {
  CallInbound16Regular,
  CallMissed16Regular,
  CallOutbound16Regular,
  Call20Regular,
  Chat20Regular,
  Person20Regular,
  Send20Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import type { CallHistoryItem, PersonView } from '@officemesh/protocol/ipc';
import { dayKey, dayLabel, presenceBadge, presenceLine } from '../format.ts';
import { PresenceDot } from '../shell/PresenceDot.tsx';
import { avatarSrc, core, displayName, nameOf, openChatWith, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import {
  inFilter,
  selectCallsPerson,
  useCallHistory,
  useCallsView,
  type CallFilter,
} from './callsStore.ts';
import { ResizeHandle, useResizableWidth } from '../shell/Resizer.tsx';
import { startCall } from './engine.ts';

const useStyles = makeStyles({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    background: tokens.colorNeutralBackground1,
  },
  history: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  head: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalS}`,
  },
  pills: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: tokens.spacingVerticalXL },
  day: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalXS}`,
    color: tokens.colorNeutralForeground3,
  },
  wrap: { position: 'relative', ':hover .om-row-more': { opacity: 1 } },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    width: 'calc(100% - 24px)',
    margin: '0 12px',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}` },
  },
  selected: { background: tokens.colorSubtleBackgroundSelected },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  missed: { color: tokens.colorPaletteRedForeground1 },
  muted: { color: tokens.colorNeutralForeground3 },
  line: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS },
  time: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  quick: {
    position: 'absolute',
    right: '84px',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    opacity: 0,
    ':focus-within': { opacity: 1 },
  },
  empty: {
    padding: tokens.spacingHorizontalXXL,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  details: {
    flex: 'none',
    width: '360px',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
    '@media (max-width: 1180px)': { display: 'none' },
  },
  // The handle between the history and the details goes with the details on a narrow window.
  handleWrap: { display: 'flex', '@media (max-width: 1180px)': { display: 'none' } },
  detailsScroll: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalXL,
  },
  hint: {
    flex: 1,
    display: 'grid',
    placeItems: 'center',
    padding: tokens.spacingHorizontalXXL,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  who: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: tokens.spacingVerticalXS,
    textAlign: 'center',
  },
  presenceLine: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS },
  actions: { display: 'flex', justifyContent: 'center', columnGap: tokens.spacingHorizontalS },
  action: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: tokens.spacingVerticalXXS,
  },
  section: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  personRow: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalM },
  callBox: {
    display: 'flex',
    flexDirection: 'column',
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
  },
  callRow: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} 0`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
});

/** "Missed video call", "Outgoing audio call", "Declined": what a history entry says. */
function callLabel(c: CallHistoryItem): string {
  const media =
    c.media === 'video' ? strings.callsPage.videoCallLower : strings.callsPage.audioCall;
  // "Missed audio call", "Cancelled video call"; the others say what happened, then what it was.
  if (c.outcome === 'missed') return `${strings.callsPage.missedWord} ${media}`;
  if (c.outcome === 'cancelled') return `${strings.callsPage.cancelledWord} ${media}`;
  if (c.outcome && c.outcome !== 'completed')
    return `${strings.calls.outcome[c.outcome]} · ${media}`;
  return `${c.direction === 'in' ? strings.callsPage.incoming : strings.callsPage.outgoing} ${media}`;
}

const length = (c: CallHistoryItem) =>
  c.answeredAt && c.endedAt ? strings.calls.duration(c.endedAt - c.answeredAt) : undefined;

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function CallIcon({ call }: { call: CallHistoryItem }) {
  const s = useStyles();
  if (call.outcome === 'missed')
    return <CallMissed16Regular className={s.missed} aria-hidden="true" />;
  return call.direction === 'in' ? (
    <CallInbound16Regular aria-hidden="true" />
  ) : (
    <CallOutbound16Regular aria-hidden="true" />
  );
}

/** The right of the Calls rail. */
export function CallsView() {
  const s = useStyles();
  // The details on the right: drag the edge between them and the history to change the width.
  const panel = useResizableWidth('calls-details', 360, 280, 640, 'left');
  const history = useCallHistory();
  const people = useApp((st) => st.people);
  const filter = useCallsView((st) => st.filter);
  const selection = useCallsView((st) => st.selection);
  const shown = useMemo(() => history.filter((c) => inFilter(c, filter)), [history, filter]);
  const days = useMemo(() => {
    const out: Array<{ key: number; label: string; items: CallHistoryItem[] }> = [];
    for (const c of shown) {
      const key = dayKey(c.startedAt);
      const last = out[out.length - 1];
      if (last?.key === key) last.items.push(c);
      else out.push({ key, label: dayLabel(c.startedAt), items: [c] });
    }
    return out;
  }, [shown]);
  const select = (c: CallHistoryItem) => {
    if (c.peers.length === 1) selectCallsPerson(c.peers[0]!, c.callId);
    else useCallsView.setState({ selection: { kind: 'call', callId: c.callId } });
  };
  const chosen = (c: CallHistoryItem) =>
    c.peers.length === 1
      ? selection?.kind === 'person' && selection.callId === c.callId
      : selection?.kind === 'call' && selection.callId === c.callId;

  return (
    <section className={s.root} data-testid="calls-view" aria-label={strings.rail.calls}>
      <div className={s.history}>
        <div className={s.head}>
          <Text as="h2" size={600} weight="semibold">
            {strings.callsPage.history}
          </Text>
          <div className={s.pills} role="group" aria-label={strings.callsPage.history}>
            {(['all', 'missed', 'incoming', 'outgoing'] as CallFilter[]).map((f) => (
              <ToggleButton
                key={f}
                size="small"
                shape="circular"
                checked={filter === f}
                onClick={() => useCallsView.setState({ filter: f })}
                data-testid={`calls-filter-${f}`}
              >
                {strings.callsPage.filters[f]}
              </ToggleButton>
            ))}
          </div>
        </div>
        <div className={s.list} data-testid="call-history">
          {days.length === 0 && (
            <Text as="p" className={s.empty} data-testid="calls-none">
              {history.length === 0 ? strings.callsPage.noCalls : strings.callsPage.noCallsFiltered}
            </Text>
          )}
          {days.map((day) => (
            <div key={day.key}>
              <Text as="p" size={200} weight="semibold" className={s.day}>
                {day.label}
              </Text>
              {day.items.map((c) => {
                const names = c.peers.map((id) => nameOf(people[id], id));
                const title =
                  names.length > 2
                    ? `${names.slice(0, 2).join(', ')} ${strings.callsPage.moreOthers(names.length - 2)}`
                    : names.join(', ');
                const missed = c.outcome === 'missed';
                const detail = [callLabel(c), length(c)].filter(Boolean).join(' · ');
                return (
                  <div key={c.callId} className={s.wrap}>
                    <button
                      type="button"
                      className={mergeClasses(s.row, chosen(c) && s.selected)}
                      onClick={() => select(c)}
                      aria-current={chosen(c) ? 'true' : undefined}
                      data-testid="call-history-item"
                      data-outcome={c.outcome ?? ''}
                    >
                      {c.peers.length === 1 ? (
                        <Avatar
                          name={title}
                          size={40}
                          color="colorful"
                          image={avatarSrc(people[c.peers[0]!]?.avatarHash)}
                        />
                      ) : (
                        <AvatarGroup size={32} layout="stack">
                          {c.peers.slice(0, 3).map((id) => (
                            <AvatarGroupItem
                              key={id}
                              name={nameOf(people[id], id)}
                              image={avatarSrc(people[id]?.avatarHash)}
                            />
                          ))}
                        </AvatarGroup>
                      )}
                      <span className={s.text}>
                        <Text
                          weight={missed ? 'semibold' : 'regular'}
                          className={mergeClasses(s.ellipsis, missed && s.missed)}
                        >
                          {title}
                        </Text>
                        <span className={mergeClasses(s.line, s.muted)}>
                          <CallIcon call={c} />
                          <Text
                            size={200}
                            className={mergeClasses(s.ellipsis, missed ? s.missed : s.muted)}
                          >
                            {detail}
                          </Text>
                        </span>
                      </span>
                      <Text size={200} className={s.time}>
                        {clock(c.startedAt)}
                      </Text>
                    </button>
                    <span className={mergeClasses('om-row-more', s.quick)}>
                      <Tooltip content={strings.calls.callBack} relationship="label">
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={c.media === 'video' ? <Video20Regular /> : <Call20Regular />}
                          aria-label={strings.calls.callBack}
                          onClick={() => void startCall(c.peers, c.media, c.convId)}
                          data-testid="call-back"
                        />
                      </Tooltip>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className={s.handleWrap}>
        <ResizeHandle
          props={panel.handleProps}
          dragging={panel.dragging}
          label={strings.callsPage.detailsResize}
          testId="calls-details-resize"
        />
      </div>
      <aside
        className={s.details}
        style={{ width: panel.width }}
        data-testid="call-details"
        aria-label={strings.callsPage.profile}
      >
        <Details history={history} />
      </aside>
    </section>
  );
}

function Details({ history }: { history: CallHistoryItem[] }) {
  const s = useStyles();
  const selection = useCallsView((st) => st.selection);
  if (!selection)
    return (
      <Text className={s.hint} data-testid="calls-select-hint">
        {strings.callsPage.selectHint}
      </Text>
    );
  if (selection.kind === 'person')
    return <PersonDetails key={selection.userId} userId={selection.userId} history={history} />;
  const call = history.find((c) => c.callId === selection.callId);
  if (!call)
    return (
      <Text className={s.hint} data-testid="calls-select-hint">
        {strings.callsPage.selectHint}
      </Text>
    );
  return <GroupDetails call={call} />;
}

/** One colleague: who, quick actions, a quick message, and every call with them. */
function PersonDetails({ userId, history }: { userId: string; history: CallHistoryItem[] }) {
  const s = useStyles();
  const person = useApp((st) => st.people[userId]);
  const name = nameOf(person, userId);
  const online = person?.online === true;
  const calls = history.filter((c) => c.peers.includes(userId));
  const days: Array<{ key: number; label: string; items: CallHistoryItem[] }> = [];
  for (const c of calls) {
    const key = dayKey(c.startedAt);
    const last = days[days.length - 1];
    if (last?.key === key) last.items.push(c);
    else days.push({ key, label: dayLabel(c.startedAt), items: [c] });
  }
  const action = (
    icon: JSX.Element,
    label: string,
    onClick: () => void,
    testId: string,
    disabled = false,
  ) => (
    <span className={s.action}>
      <Button
        shape="circular"
        size="large"
        icon={icon}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
      />
      <Text size={200} className={s.muted}>
        {label}
      </Text>
    </span>
  );
  return (
    <div className={s.detailsScroll} data-testid="calls-person" data-user={userId}>
      <div className={s.who}>
        <Avatar
          name={name}
          size={72}
          color="colorful"
          image={avatarSrc(person?.avatarHash)}
          badge={presenceBadge(person?.presence ?? 'offline')}
        />
        <Text as="h3" size={500} weight="semibold">
          {name}
        </Text>
        {person?.jobTitle && <Text className={s.muted}>{person.jobTitle}</Text>}
        {person && (
          <span className={s.presenceLine}>
            <PresenceDot state={person.presence} />
            <Text size={200} className={s.muted}>
              {presenceLine(person)}
            </Text>
          </span>
        )}
      </div>
      <div className={s.actions}>
        {action(
          <Chat20Regular />,
          strings.callsPage.chat,
          () => void openChatWith(userId),
          'calls-action-chat',
        )}
        {action(
          <Call20Regular />,
          strings.callsPage.audio,
          () => void startCall([userId], 'audio'),
          'calls-action-audio',
          !online,
        )}
        {action(
          <Video20Regular />,
          strings.callsPage.videoCall,
          () => void startCall([userId], 'video'),
          'calls-action-video',
          !online,
        )}
        {action(
          <Person20Regular />,
          strings.callsPage.profile,
          () => useApp.setState({ rail: 'people', selectedPerson: userId }),
          'calls-action-profile',
        )}
      </div>
      <QuickMessage userId={userId} name={name} />
      <div className={s.section}>
        <Text weight="semibold">{strings.callsPage.callsWith(name)}</Text>
        {calls.length === 0 ? (
          <Text size={200} className={s.muted} data-testid="calls-person-none">
            {strings.callsPage.noCallsWith}
          </Text>
        ) : (
          days.map((day) => (
            <div key={day.key} className={s.section}>
              <Text size={200} className={s.muted}>
                {day.label}
              </Text>
              <div className={s.callBox}>
                {day.items.map((c) => (
                  <div key={c.callId} className={s.callRow} data-testid="calls-person-call">
                    <CallIcon call={c} />
                    <span className={s.text}>
                      <Text size={300} className={c.outcome === 'missed' ? s.missed : undefined}>
                        {callLabel(c)}
                      </Text>
                      <Text size={200} className={s.muted}>
                        {[clock(c.startedAt), length(c)].filter(Boolean).join(' · ')}
                      </Text>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** A call with several people: who was in it, and a way to call them all again. */
function GroupDetails({ call }: { call: CallHistoryItem }) {
  const s = useStyles();
  const people = useApp((st) => st.people);
  return (
    <div className={s.detailsScroll} data-testid="calls-group">
      <div className={s.who}>
        <AvatarGroup size={56} layout="stack">
          {call.peers.slice(0, 4).map((id) => (
            <AvatarGroupItem
              key={id}
              name={nameOf(people[id], id)}
              image={avatarSrc(people[id]?.avatarHash)}
            />
          ))}
        </AvatarGroup>
        <Text as="h3" size={500} weight="semibold">
          {strings.callsPage.group}
        </Text>
        <Text size={200} className={s.muted}>
          {callLabel(call)} · {clock(call.startedAt)}
        </Text>
      </div>
      <div className={s.actions}>
        <Button
          appearance="primary"
          icon={<Call20Regular />}
          onClick={() => void startCall(call.peers, 'audio', call.convId)}
          data-testid="calls-group-audio"
        >
          {strings.callsPage.callBackGroup}
        </Button>
        <Button
          icon={<Video20Regular />}
          aria-label={strings.callsPage.videoCall}
          onClick={() => void startCall(call.peers, 'video', call.convId)}
          data-testid="calls-group-video"
        />
      </div>
      <div className={s.section}>
        <Text weight="semibold">{strings.callsPage.participants}</Text>
        {call.peers.map((id) => {
          const person: PersonView | undefined = people[id];
          return (
            <button
              key={id}
              type="button"
              className={mergeClasses(s.row, s.personRow)}
              style={{ width: '100%', margin: 0 }}
              onClick={() => selectCallsPerson(id)}
            >
              <Avatar
                name={nameOf(person, id)}
                size={32}
                color="colorful"
                image={avatarSrc(person?.avatarHash)}
                badge={presenceBadge(person?.presence ?? 'offline')}
              />
              <Text>{displayName(id)}</Text>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A text box that sends a message to the colleague's chat without leaving the Calls page. */
function QuickMessage({ userId, name }: { userId: string; name: string }) {
  const s = useStyles();
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const send = async () => {
    const body = text.trim();
    if (!body || state === 'sending') return;
    setState('sending');
    try {
      const conv = await core.invoke('conversations.openDirect', { userId });
      useApp.setState((st) => ({ conversations: { ...st.conversations, [conv.convId]: conv } }));
      await core.invoke('messages.send', { convId: conv.convId, text: body });
      setText('');
      setState('sent');
    } catch {
      setState('error');
    }
  };
  return (
    <div className={s.section}>
      <Text weight="semibold">{strings.callsPage.quickMessage}</Text>
      <Input
        value={text}
        placeholder={strings.callsPage.quickPlaceholder(name)}
        aria-label={strings.callsPage.quickMessage}
        onChange={(_e, d) => {
          setText(d.value);
          setState('idle');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void send();
        }}
        contentAfter={
          <Button
            appearance="transparent"
            size="small"
            icon={<Send20Regular />}
            aria-label={strings.callsPage.send}
            disabled={!text.trim() || state === 'sending'}
            onClick={() => void send()}
            data-testid="calls-quick-send"
          />
        }
        data-testid="calls-quick-input"
      />
      {state === 'sent' && (
        <Text size={200} className={s.muted} role="status" data-testid="calls-quick-sent">
          {strings.callsPage.sent}
        </Text>
      )}
      {state === 'error' && (
        <Text size={200} className={s.missed} role="alert">
          {strings.callsPage.sendFailed}
        </Text>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Divider,
  Field,
  Input,
  makeStyles,
  mergeClasses,
  Select,
  Switch,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  Add16Regular,
  ArrowUndo16Regular,
  CheckboxChecked20Filled,
  CheckboxUnchecked20Regular,
  Clock16Regular,
  Copy16Regular,
  Dismiss16Regular,
  EyeOff16Regular,
  LockClosed16Regular,
  People16Regular,
  Poll16Regular,
  RadioButton20Filled,
  RadioButton20Regular,
  Trophy16Regular,
} from '@fluentui/react-icons';
import type { MsgRef } from '@officemesh/protocol';
import type { MessageView } from '@officemesh/protocol/ipc';
import { shortTime } from '../format.ts';
import { act, avatarSrc, core, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';

type PollView = NonNullable<MessageView['poll']>;

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    minWidth: '280px',
    maxWidth: '440px',
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
  },
  kind: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXXS,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXXS,
    padding: `0 ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
  },
  chipClosed: {
    background: tokens.colorNeutralBackground5,
    color: tokens.colorNeutralForeground2,
  },
  options: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS },
  option: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    overflow: 'hidden',
    cursor: 'pointer',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    ':hover:enabled': { border: `1px solid ${tokens.colorNeutralStroke1Hover}` },
    ':disabled': { cursor: 'default' },
  },
  mine: { border: `1px solid ${tokens.colorBrandStroke1}` },
  full: { opacity: 0.6 },
  bar: {
    position: 'absolute',
    inset: '0 auto 0 0',
    background: tokens.colorBrandBackground2,
    transitionProperty: 'width',
    transitionDuration: tokens.durationNormal,
    zIndex: 0,
  },
  barWinner: { background: tokens.colorBrandBackground2Hover },
  mark: { position: 'relative', zIndex: 1, display: 'flex', flexShrink: 0 },
  markOn: { color: tokens.colorBrandForeground1 },
  text: { position: 'relative', zIndex: 1, flex: 1, minWidth: 0, overflowWrap: 'anywhere' },
  winner: { fontWeight: tokens.fontWeightSemibold },
  count: {
    position: 'relative',
    zIndex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    flexShrink: 0,
    color: tokens.colorNeutralForeground2,
    fontVariantNumeric: 'tabular-nums',
  },
  note: { color: tokens.colorNeutralForeground3 },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
  actions: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalXXS },
  voteList: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  voteGroup: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS },
  voter: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  dialog: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  optionRow: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS },
  optionInput: { flex: 1 },
  settings: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  help: { color: tokens.colorNeutralForeground3 },
});

/** The clock, ticking while something on screen counts down to `until`. */
function useNow(until: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === undefined || now >= until) return;
    // Every 30 s, and exactly at the deadline.
    const wait = Math.min(30_000, until - now + 50);
    const t = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(t);
  }, [until, now]);
  return now;
}

const dayTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** "in 12 min", "in 3 h", "Fri 5:00 PM", "Oct 24, 9:00 AM". */
function untilText(at: number, now: number): string {
  const left = at - now;
  if (left < 3_600_000) return `in ${Math.max(1, Math.ceil(left / 60_000))} min`;
  if (left < 24 * 3_600_000) return `in ${Math.round(left / 3_600_000)} h`;
  return (left < 6 * 86_400_000 ? dayTime : dateTime).format(new Date(at));
}

const percent = (votes: number, voters: number) =>
  voters ? Math.round((votes / voters) * 100) : 0;

/** The results as plain text, for pasting elsewhere. */
function resultsText(poll: PollView, closed: boolean): string {
  const lines = [`${poll.question}${closed ? ` (${strings.polls.copyClosed})` : ''}`];
  for (const o of poll.options)
    lines.push(
      `${o.text}: ${strings.polls.votes(o.votes)} (${percent(o.votes, poll.voters)}%)` +
        (o.voters?.length ? ` - ${o.voters.map(displayName).join(', ')}` : ''),
    );
  lines.push(strings.polls.people(poll.voters));
  return lines.join('\n');
}

export function PollCard({ message: m }: { message: MessageView }) {
  const s = useStyles();
  const poll = m.poll!;
  const target = { author: m.author, seq: m.seq };
  const convId = m.convId;
  const now = useNow(poll.closed ? undefined : poll.closesAt);
  // The core says so within seconds too; the card does not wait for it.
  const closed = poll.closed || (poll.closesAt !== undefined && now >= poll.closesAt);
  const [confirming, setConfirming] = useState(false);
  const [showVotes, setShowVotes] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const mine = poll.options.flatMap((o, i) => (o.mine ? [i] : []));
  const limit = poll.multi ? (poll.maxChoices ?? poll.options.length) : 1;
  const top = Math.max(0, ...poll.options.map((o) => o.votes));
  const shown = !poll.hidden;
  const named = shown && !poll.anonymous && poll.options.some((o) => o.voters?.length);

  const send = (choices: number[]) => {
    setError(undefined);
    void act(convId, () => core.invoke('polls.vote', { convId, target, choices })).catch(
      (err: unknown) => setError(err instanceof Error ? err.message.replace(/^.*?: /, '') : ''),
    );
  };
  const vote = (i: number) => {
    if (!poll.multi) return send(mine.includes(i) ? [] : [i]);
    if (mine.includes(i)) return send(mine.filter((c) => c !== i));
    if (mine.length >= limit) return;
    send([...mine, i]);
  };

  return (
    <div className={s.card} data-testid="poll" data-closed={closed}>
      <div className={s.head}>
        <span className={s.kind}>
          <Poll16Regular />
          {strings.polls.label}
        </span>
        <Text size={200}>
          {!poll.multi
            ? strings.polls.chooseOne
            : poll.maxChoices
              ? strings.polls.chooseUpTo(poll.maxChoices)
              : strings.polls.chooseAny}
        </Text>
        {poll.anonymous && (
          <span className={s.chip} data-testid="poll-anonymous">
            <EyeOff16Regular />
            {strings.polls.anonymousChip}
          </span>
        )}
        {closed ? (
          <span className={mergeClasses(s.chip, s.chipClosed)} data-testid="poll-status">
            <LockClosed16Regular />
            {poll.closedAt !== undefined || poll.closesAt !== undefined
              ? strings.polls.closedAt(shortTime(poll.closedAt ?? poll.closesAt!, now))
              : strings.polls.closed}
          </span>
        ) : (
          poll.closesAt !== undefined && (
            <span className={s.chip} data-testid="poll-status">
              <Clock16Regular />
              {strings.polls.closesIn(untilText(poll.closesAt, now))}
            </span>
          )
        )}
      </div>
      <Text weight="semibold" size={400} data-testid="poll-title">
        {poll.question}
      </Text>
      <div
        className={s.options}
        role={poll.multi ? 'group' : 'radiogroup'}
        aria-label={poll.question}
      >
        {poll.options.map((o, i) => {
          const full = poll.multi && !o.mine && mine.length >= limit;
          const winner = closed && shown && o.votes > 0 && o.votes === top;
          const Mark = poll.multi
            ? o.mine
              ? CheckboxChecked20Filled
              : CheckboxUnchecked20Regular
            : o.mine
              ? RadioButton20Filled
              : RadioButton20Regular;
          return (
            <button
              key={i}
              type="button"
              role={poll.multi ? 'checkbox' : 'radio'}
              aria-checked={o.mine}
              aria-pressed={o.mine}
              className={mergeClasses(s.option, o.mine && s.mine, full && !closed && s.full)}
              disabled={closed || full}
              onClick={() => vote(i)}
              data-testid={`poll-option-${i}`}
            >
              {shown && (
                <span
                  className={mergeClasses(s.bar, winner && s.barWinner)}
                  style={{ width: `${percent(o.votes, poll.voters)}%` }}
                />
              )}
              <span className={mergeClasses(s.mark, o.mine && s.markOn)} aria-hidden="true">
                <Mark />
              </span>
              <Text className={mergeClasses(s.text, winner && s.winner)}>{o.text}</Text>
              {shown && (
                <span className={s.count} data-testid={`poll-votes-${i}`} data-votes={o.votes}>
                  {winner && (
                    <Tooltip content={strings.polls.winner} relationship="label">
                      <Trophy16Regular data-testid={`poll-winner-${i}`} />
                    </Tooltip>
                  )}
                  <Text size={200} weight="semibold">
                    {percent(o.votes, poll.voters)}%
                  </Text>
                  <Text size={200}>{o.votes}</Text>
                </span>
              )}
            </button>
          );
        })}
      </div>
      {poll.hidden && (
        <Text size={200} className={s.note} data-testid="poll-hidden">
          {poll.hidden === 'voted'
            ? strings.polls.hiddenUntilVote
            : strings.polls.hiddenUntilClosed}
        </Text>
      )}
      {error && (
        <Text size={200} role="alert">
          {error}
        </Text>
      )}
      <div className={s.footer}>
        <Text size={200} data-testid="poll-voters">
          {strings.polls.people(poll.voters)}
        </Text>
        <div className={s.actions}>
          {!closed && mine.length > 0 && (
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowUndo16Regular />}
              onClick={() => send([])}
              data-testid="poll-withdraw"
            >
              {strings.polls.withdraw}
            </Button>
          )}
          {named && (
            <Button
              size="small"
              appearance="subtle"
              icon={<People16Regular />}
              onClick={() => setShowVotes(true)}
              data-testid="poll-see-votes"
            >
              {strings.polls.seeVotes}
            </Button>
          )}
          {shown && poll.voters > 0 && (
            <Tooltip
              content={copied ? strings.polls.copied : strings.polls.copy}
              relationship="label"
            >
              <Button
                size="small"
                appearance="subtle"
                icon={<Copy16Regular />}
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(resultsText(poll, closed))
                    .then(() => setCopied(true))
                    .catch(() => {})
                }
                onMouseLeave={() => setCopied(false)}
                data-testid="poll-copy"
              />
            </Tooltip>
          )}
          {m.mine && !closed && (
            <Button
              size="small"
              appearance="subtle"
              icon={<LockClosed16Regular />}
              data-testid="poll-close"
              onClick={() => setConfirming(true)}
            >
              {strings.polls.close}
            </Button>
          )}
        </div>
      </div>
      {confirming && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setConfirming(false)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{strings.polls.closeConfirm}</DialogTitle>
              <DialogContent>{strings.polls.closeConfirmBody}</DialogContent>
              <DialogActions>
                <Button onClick={() => setConfirming(false)}>{strings.me.cancel}</Button>
                <Button
                  appearance="primary"
                  data-testid="poll-close-confirm"
                  onClick={() => {
                    setConfirming(false);
                    void act(convId, () => core.invoke('polls.close', { convId, target }));
                  }}
                >
                  {strings.polls.close}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
      {showVotes && <VotesDialog poll={poll} onClose={() => setShowVotes(false)} />}
    </div>
  );
}

/** Who chose each option (polls that show names). */
function VotesDialog({ poll, onClose }: { poll: PollView; onClose: () => void }) {
  const s = useStyles();
  const people = useApp((st) => st.people);
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface aria-label={strings.polls.votesTitle}>
        <DialogBody>
          <DialogTitle>{poll.question}</DialogTitle>
          <DialogContent className={s.voteList} data-testid="poll-votes-dialog">
            {poll.options.map((o, i) => (
              <div key={i} className={s.voteGroup}>
                <Text weight="semibold">
                  {o.text} · {strings.polls.votes(o.votes)}
                </Text>
                {(o.voters ?? []).length === 0 ? (
                  <Text size={200} className={s.help}>
                    {strings.polls.noVotes}
                  </Text>
                ) : (
                  (o.voters ?? []).map((id) => {
                    const person = people[id];
                    return (
                      <div key={id} className={s.voter} data-testid="poll-voter" data-user={id}>
                        <Avatar
                          size={24}
                          color="colorful"
                          name={displayName(id)}
                          image={avatarSrc(person?.avatarHash)}
                        />
                        <Text>{displayName(id)}</Text>
                      </div>
                    );
                  })
                )}
              </div>
            ))}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              {strings.settings.close}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

type Closes = keyof typeof strings.polls.closesOptions;

/** `yyyy-mm-ddThh:mm` in local time, as a datetime-local input wants it. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function closingTime(choice: Closes, custom: string, now: number): number | undefined {
  switch (choice) {
    case 'never':
      return undefined;
    case 'hour':
      return now + 3_600_000;
    case 'today': {
      const end = new Date(now);
      end.setHours(23, 59, 0, 0);
      // Late at night "the end of today" is too close: an hour from now instead.
      return Math.max(end.getTime(), now + 3_600_000);
    }
    case 'day':
      return now + 24 * 3_600_000;
    case 'week':
      return now + 7 * 24 * 3_600_000;
    case 'custom': {
      const at = new Date(custom).getTime();
      return Number.isFinite(at) ? at : NaN;
    }
  }
}

export function PollDialog({
  convId,
  thread,
  onClose,
}: {
  convId: string;
  thread?: MsgRef | undefined;
  onClose: () => void;
}) {
  const s = useStyles();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [maxChoices, setMaxChoices] = useState(0);
  const [anonymous, setAnonymous] = useState(false);
  const [results, setResults] = useState<'always' | 'voted' | 'closed'>('always');
  const [closes, setCloses] = useState<Closes>('never');
  const [custom, setCustom] = useState(() => {
    const d = new Date(Date.now() + 24 * 3_600_000);
    d.setMinutes(0, 0, 0);
    return localInput(d.getTime());
  });
  const [error, setError] = useState<string>();
  const [posting, setPosting] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  // The time the closing choice is checked against, kept current while the dialog is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const focusNext = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (focusNext.current === undefined) return;
    inputs.current[focusNext.current]?.focus();
    focusNext.current = undefined;
  });

  const trimmed = options.map((o) => o.trim());
  const filled = trimmed.filter(Boolean);
  // The second of two equal options is the one marked.
  const duplicateAt = trimmed.map(
    (o, i) =>
      o !== '' && trimmed.findIndex((x) => x.toLocaleLowerCase() === o.toLocaleLowerCase()) !== i,
  );
  const hasDuplicate = duplicateAt.some(Boolean);
  const customAt = closes === 'custom' ? closingTime('custom', custom, now) : undefined;
  const customBad =
    closes === 'custom' &&
    (customAt === undefined || !Number.isFinite(customAt) || customAt < now + 60_000);
  const canPost =
    !posting && question.trim() !== '' && filled.length >= 2 && !hasDuplicate && !customBad;
  const limitChoices = Array.from({ length: Math.max(0, filled.length - 2) }, (_, i) => i + 2);

  const post = () => {
    setPosting(true);
    setError(undefined);
    const closesAt = closingTime(closes, custom, Date.now());
    const max = multi && maxChoices >= 2 && maxChoices < filled.length ? maxChoices : undefined;
    void act(convId, () =>
      core.invoke('polls.create', {
        convId,
        question: question.trim(),
        options: filled,
        ...(multi && { multi }),
        ...(max !== undefined && { maxChoices: max }),
        ...(anonymous && { anonymous }),
        ...(results !== 'always' && { results }),
        ...(closesAt !== undefined && { closesAt }),
        ...(thread && { thread }),
      }),
    )
      .then(onClose)
      .catch((err: unknown) => {
        setPosting(false);
        setError(err instanceof Error ? err.message.replace(/^.*?: /, '') : String(err));
      });
  };

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.polls.create}</DialogTitle>
          <DialogContent className={s.dialog}>
            <Field label={strings.polls.question} required>
              <Input
                value={question}
                maxLength={300}
                placeholder={strings.polls.questionPlaceholder}
                onChange={(_e, d) => setQuestion(d.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    inputs.current[0]?.focus();
                  }
                }}
                data-testid="poll-question"
                autoFocus
              />
            </Field>
            <Field label={strings.polls.options} required>
              <div className={s.settings}>
                {options.map((o, i) => (
                  <Field
                    key={i}
                    validationState={duplicateAt[i] ? 'error' : 'none'}
                    validationMessage={duplicateAt[i] ? strings.polls.duplicate : undefined}
                  >
                    <div className={s.optionRow}>
                      <Input
                        className={s.optionInput}
                        ref={(el) => {
                          inputs.current[i] = el;
                        }}
                        value={o}
                        maxLength={100}
                        placeholder={strings.polls.option(i + 1)}
                        aria-label={strings.polls.option(i + 1)}
                        onChange={(_e, d) =>
                          setOptions(options.map((x, j) => (j === i ? d.value : x)))
                        }
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          e.preventDefault();
                          // Enter goes to the next option, adding one at the end (up to 10).
                          if (i === options.length - 1 && options.length < 10 && o.trim()) {
                            focusNext.current = i + 1;
                            setOptions([...options, '']);
                          } else inputs.current[i + 1]?.focus();
                        }}
                        data-testid={`poll-option-input-${i}`}
                      />
                      {options.length > 2 && (
                        <Button
                          appearance="subtle"
                          size="small"
                          icon={<Dismiss16Regular />}
                          aria-label={strings.polls.removeOption(i + 1)}
                          onClick={() => setOptions(options.filter((_, j) => j !== i))}
                          data-testid={`poll-option-remove-${i}`}
                        />
                      )}
                    </div>
                  </Field>
                ))}
                {options.length < 10 && (
                  <Button
                    appearance="subtle"
                    icon={<Add16Regular />}
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => {
                      focusNext.current = options.length;
                      setOptions([...options, '']);
                    }}
                    data-testid="poll-add-option"
                  >
                    {strings.polls.addOption}
                  </Button>
                )}
              </div>
            </Field>
            <Divider />
            <div className={s.settings}>
              <Switch
                checked={multi}
                onChange={(_e, d) => setMulti(d.checked)}
                label={strings.polls.multi}
                data-testid="poll-multi"
              />
              {multi && limitChoices.length > 0 && (
                <Field label={strings.polls.maxChoices} orientation="horizontal">
                  <Select
                    value={String(maxChoices)}
                    onChange={(_e, d) => setMaxChoices(Number(d.value))}
                    data-testid="poll-max-choices"
                  >
                    <option value="0">{strings.polls.anyNumber}</option>
                    {limitChoices.map((n) => (
                      <option key={n} value={n}>
                        {strings.polls.upTo(n)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <div>
                <Switch
                  checked={anonymous}
                  onChange={(_e, d) => setAnonymous(d.checked)}
                  label={strings.polls.anonymous}
                  data-testid="poll-anonymous-switch"
                />
                <Text size={200} block className={s.help}>
                  {strings.polls.anonymousHelp}
                </Text>
              </div>
              <Field
                label={strings.polls.results}
                hint={results !== 'always' ? strings.polls.resultsHelp : undefined}
              >
                <Select
                  value={results}
                  onChange={(_e, d) => setResults(d.value as typeof results)}
                  data-testid="poll-results"
                >
                  {(['always', 'voted', 'closed'] as const).map((k) => (
                    <option key={k} value={k}>
                      {strings.polls.resultsOptions[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={strings.polls.closes}>
                <Select
                  value={closes}
                  onChange={(_e, d) => setCloses(d.value as Closes)}
                  data-testid="poll-closes"
                >
                  {(Object.keys(strings.polls.closesOptions) as Closes[]).map((k) => (
                    <option key={k} value={k}>
                      {strings.polls.closesOptions[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              {closes === 'custom' && (
                <Field
                  label={strings.polls.closesAt}
                  validationState={customBad ? 'error' : 'none'}
                  validationMessage={customBad ? strings.polls.closesPast : undefined}
                >
                  <Input
                    type="datetime-local"
                    value={custom}
                    min={localInput(now + 60_000)}
                    onChange={(_e, d) => setCustom(d.value)}
                    data-testid="poll-closes-at"
                  />
                </Field>
              )}
            </div>
            {error && (
              <Text size={200} role="alert" data-testid="poll-error">
                {error}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
            <Button appearance="primary" disabled={!canPost} data-testid="poll-post" onClick={post}>
              {strings.polls.post}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

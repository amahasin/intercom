import { Avatar, Button, makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';
import { CallEnd24Filled } from '@fluentui/react-icons';
import { avatarSrc, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { dismissEnding, startCall, useCall, type EndedCall } from './engine.ts';

const useStyles = makeStyles({
  screen: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: tokens.spacingVerticalM,
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    textAlign: 'center',
    padding: tokens.spacingHorizontalXXL,
  },
  // Fills the small ring window it appears in.
  card: {
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
  },
  badge: {
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    background: tokens.colorNeutralBackground5,
  },
  badgeBad: { background: tokens.colorPaletteRedBackground3 },
  badgeSoft: { background: tokens.colorPaletteMarigoldBackground3 },
  detail: { color: tokens.colorNeutralForeground2 },
  actions: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalM,
  },
  cardText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
});

const BAD = new Set(['missed', 'declined']);
const SOFT = new Set(['no-answer', 'busy', 'dnd']);

/** The line under the title: with whom, for how long, or why the call did not connect. */
export function endedDetail(e: EndedCall): string {
  const name = e.decline?.name ?? e.who;
  switch (e.outcome) {
    case 'completed':
      return [
        e.who ? strings.calls.endedWith(e.who) : '',
        e.durationMs ? strings.calls.duration(e.durationMs) : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'cancelled':
      return e.who ? strings.calls.endedCancelled(e.who) : '';
    case 'missed':
      return e.who ? strings.calls.endedMissed(e.who) : '';
    case 'declined':
      return e.direction === 'in'
        ? strings.calls.endedYouDeclined
        : strings.calls.ended.declined(name);
    case 'no-answer':
      return strings.calls.ended['no-answer'](name);
    case 'busy':
      return strings.calls.ended.busy(name);
    case 'dnd':
      return strings.calls.ended.dnd(name);
  }
}

function Body({ ending, compact }: { ending: EndedCall; compact?: boolean }) {
  const s = useStyles();
  const person = useApp((st) => (ending.peer ? st.people[ending.peer] : undefined));
  const callBack =
    ending.peer &&
    !['completed', 'cancelled'].includes(ending.outcome) &&
    ending.direction === 'out'
      ? ending.peer
      : ending.peer && ending.outcome === 'missed'
        ? ending.peer
        : undefined;
  const icon = person ? (
    <Avatar
      name={ending.who}
      size={compact ? 40 : 72}
      color="colorful"
      image={avatarSrc(person.avatarHash)}
    />
  ) : (
    <span
      className={mergeClasses(
        s.badge,
        BAD.has(ending.outcome) && s.badgeBad,
        SOFT.has(ending.outcome) && s.badgeSoft,
      )}
    >
      <CallEnd24Filled />
    </span>
  );
  const text = (
    <>
      <Text size={compact ? 400 : 700} weight="semibold" block data-testid="call-ended-title">
        {strings.calls.endedTitle[ending.outcome]}
      </Text>
      <Text size={compact ? 200 : 400} className={s.detail} block data-testid="call-ended-detail">
        {endedDetail(ending)}
      </Text>
    </>
  );
  return compact ? (
    <>
      {icon}
      <div className={s.cardText}>{text}</div>
      <Button
        size="small"
        appearance="subtle"
        onClick={dismissEnding}
        data-testid="call-ended-close"
      >
        {strings.calls.close}
      </Button>
    </>
  ) : (
    <>
      {icon}
      {text}
      <div className={s.actions}>
        {callBack && (
          <Button
            appearance="primary"
            onClick={() => {
              void startCall([callBack], ending.media);
              dismissEnding();
            }}
            data-testid="call-ended-callback"
          >
            {strings.calls.callBack}
          </Button>
        )}
        <Button onClick={dismissEnding} data-testid="call-ended-close">
          {strings.calls.close}
        </Button>
      </div>
    </>
  );
}

/** Where the call window was: what happened to the call, for a moment, before it closes. */
export function CallEndedScreen() {
  const s = useStyles();
  const ending = useCall((st) => st.ending);
  if (!ending || ending.view !== 'full') return null;
  return (
    <section
      className={s.screen}
      role="status"
      aria-live="polite"
      data-testid="call-ended"
      data-outcome={ending.outcome}
    >
      <Body ending={ending} />
    </section>
  );
}

/** The same message as a small card, for a ringing call that stopped or a call in the mini view. */
export function CallEndedCard() {
  const s = useStyles();
  const ending = useCall((st) => st.ending);
  if (!ending || ending.view !== 'card') return null;
  return (
    <div
      className={s.card}
      role="status"
      aria-live="polite"
      data-testid="call-ended"
      data-outcome={ending.outcome}
    >
      <Body ending={ending} compact />
    </div>
  );
}

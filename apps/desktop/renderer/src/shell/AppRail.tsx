import { CounterBadge, makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';
import {
  Alert24Filled,
  Alert24Regular,
  bundleIcon,
  CalendarLtr24Filled,
  CalendarLtr24Regular,
  Call24Filled,
  Call24Regular,
  Chat24Filled,
  Chat24Regular,
  Document24Filled,
  Document24Regular,
  PeopleTeam24Filled,
  PeopleTeam24Regular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { useApp, type RailId } from '../state.ts';
import { strings } from '../strings.ts';

const items: Array<{ id: RailId; icon: FluentIcon }> = [
  { id: 'activity', icon: bundleIcon(Alert24Filled, Alert24Regular) },
  { id: 'chat', icon: bundleIcon(Chat24Filled, Chat24Regular) },
  { id: 'teams', icon: bundleIcon(PeopleTeam24Filled, PeopleTeam24Regular) },
  { id: 'calendar', icon: bundleIcon(CalendarLtr24Filled, CalendarLtr24Regular) },
  { id: 'calls', icon: bundleIcon(Call24Filled, Call24Regular) },
  { id: 'files', icon: bundleIcon(Document24Filled, Document24Regular) },
];

const useStyles = makeStyles({
  rail: {
    width: '68px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalXS,
  },
  item: {
    position: 'relative',
    width: '60px',
    height: '56px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: '2px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    ':hover': {
      background: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground2BrandHover,
    },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}` },
  },
  selected: {
    color: tokens.colorBrandForeground1,
    '::before': {
      content: '""',
      position: 'absolute',
      left: '-4px',
      top: '14px',
      bottom: '14px',
      width: '3px',
      borderRadius: tokens.borderRadiusCircular,
      background: tokens.colorBrandStroke1,
    },
  },
  label: { fontSize: tokens.fontSizeBase100 },
});

export function AppRail() {
  const styles = useStyles();
  const rail = useApp((s) => s.rail);
  const setRail = useApp((s) => s.setRail);
  const unread =
    (channels: boolean) =>
    (s: { conversations: Record<string, { kind: string; notify: string; unread: number }> }) =>
      Object.values(s.conversations).reduce(
        (n, c) => n + ((c.kind === 'channel') !== channels || c.notify === 'muted' ? 0 : c.unread),
        0,
      );
  const chatUnread = useApp(unread(false));
  const teamsUnread = useApp(unread(true));
  const activityUnread = useApp((s) => s.activityUnread);
  const counts: Partial<Record<RailId, number>> = {
    chat: chatUnread,
    teams: teamsUnread,
    activity: activityUnread,
  };
  return (
    <nav className={styles.rail} aria-label="Apps">
      {items.map(({ id, icon: Icon }) => {
        const selected = rail === id;
        return (
          <button
            key={id}
            type="button"
            className={mergeClasses(styles.item, selected && styles.selected)}
            aria-current={selected ? 'page' : undefined}
            onClick={() => setRail(id)}
            data-testid={`rail-${id}`}
          >
            <Icon filled={selected} aria-hidden />
            {(counts[id] ?? 0) > 0 && (
              <CounterBadge
                count={counts[id]}
                size="small"
                color="danger"
                style={{ position: 'absolute', top: 4, right: 10 }}
                data-testid={`rail-${id}-badge`}
              />
            )}
            <Text className={styles.label} weight={selected ? 'semibold' : 'regular'}>
              {strings.rail[id]}
            </Text>
          </button>
        );
      })}
    </nav>
  );
}

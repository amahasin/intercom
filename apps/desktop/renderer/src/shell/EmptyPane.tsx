import type { JSX } from 'react';
import { makeStyles, Text, tokens } from '@fluentui/react-components';
import {
  Alert24Regular,
  Call24Regular,
  Chat24Regular,
  People24Regular,
} from '@fluentui/react-icons';
import { strings } from '../strings.ts';
import type { RailId } from '../state.ts';

const useStyles = makeStyles({
  pane: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalXXL,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
    background: tokens.colorNeutralBackground1,
  },
  icon: {
    width: '64px',
    height: '64px',
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    marginBottom: tokens.spacingVerticalS,
  },
});

const ICONS: Partial<Record<RailId, JSX.Element>> = {
  activity: <Alert24Regular />,
  calls: <Call24Regular />,
  teams: <People24Regular />,
  chat: <Chat24Regular />,
  people: <People24Regular />,
};

/** What the main area shows when a rail has nothing selected, instead of someone else's page. */
export function EmptyPane({ rail }: { rail: RailId }) {
  const styles = useStyles();
  const text = strings.emptyPane[rail as keyof typeof strings.emptyPane];
  if (!text) return null;
  return (
    <section className={styles.pane} data-testid="empty-pane" data-rail={rail}>
      <span className={styles.icon}>{ICONS[rail]}</span>
      <Text size={500} weight="semibold" block>
        {text.title}
      </Text>
      <Text size={300} block style={{ maxWidth: 380 }}>
        {text.hint}
      </Text>
    </section>
  );
}

import { makeStyles, Text, tokens } from '@fluentui/react-components';
import { ActivityPane } from '../activity/ActivityPane.tsx';
import { ChatList } from '../chat/ChatList.tsx';
import { useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  pane: {
    width: '320px',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: tokens.colorNeutralBackground2,
    borderTopLeftRadius: tokens.borderRadiusXLarge,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  header: { padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}` },
  empty: {
    padding: `0 ${tokens.spacingHorizontalL}`,
    color: tokens.colorNeutralForeground3,
  },
});

export function ListPane() {
  const styles = useStyles();
  const rail = useApp((s) => s.rail);
  return (
    <section className={styles.pane} aria-label={strings.rail[rail]}>
      <div className={styles.header}>
        <Text as="h1" size={500} weight="bold">
          {strings.rail[rail]}
        </Text>
      </div>
      {rail === 'chat' ? (
        <ChatList />
      ) : rail === 'activity' ? (
        <ActivityPane />
      ) : (
        <Text className={styles.empty} size={200}>
          {strings.listEmpty[rail]}
        </Text>
      )}
    </section>
  );
}

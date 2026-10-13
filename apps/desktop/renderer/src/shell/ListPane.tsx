import { makeStyles, Text, tokens } from '@fluentui/react-components';
import { ActivityPane } from '../activity/ActivityPane.tsx';
import { ChatList } from '../chat/ChatList.tsx';
import { CalendarSidebar } from '../calendar/CalendarSidebar.tsx';
import { CallsPane } from '../calls/CallsPane.tsx';
import { TeamsList } from '../teams/TeamsList.tsx';
import { useApp } from '../state.ts';
import { ResizeHandle, useResizableWidth } from './Resizer.tsx';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  pane: {
    flex: 'none',
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
  const list = useResizableWidth('list', 320, 240, 560, 'right');
  return (
    <>
      <section
        className={styles.pane}
        style={{ width: list.width }}
        aria-label={strings.rail[rail]}
        data-testid="list-pane"
      >
        <div className={styles.header}>
          <Text as="h1" size={500} weight="bold">
            {strings.rail[rail]}
          </Text>
        </div>
        {rail === 'chat' ? (
          <ChatList />
        ) : rail === 'people' ? (
          <ChatList view="people" />
        ) : rail === 'activity' ? (
          <ActivityPane />
        ) : rail === 'teams' ? (
          <TeamsList />
        ) : rail === 'calls' ? (
          <CallsPane />
        ) : rail === 'calendar' ? (
          <CalendarSidebar />
        ) : (
          <Text className={styles.empty} size={200}>
            {strings.listEmpty[rail]}
          </Text>
        )}
      </section>
      <ResizeHandle
        props={list.handleProps}
        dragging={list.dragging}
        label={strings.listPaneResize}
        testId="list-resize"
      />
    </>
  );
}

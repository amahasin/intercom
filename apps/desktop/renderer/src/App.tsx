import {
  makeStyles,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  tokens,
} from '@fluentui/react-components';
import { AppRail } from './shell/AppRail.tsx';
import { Home } from './shell/Home.tsx';
import { ListPane } from './shell/ListPane.tsx';
import { TitleBar } from './shell/TitleBar.tsx';
import { useApp } from './state.ts';
import { strings } from './strings.ts';

const useStyles = makeStyles({
  root: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    color: tokens.colorNeutralForeground1,
  },
  body: { flex: 1, display: 'flex', minHeight: 0 },
  content: {
    flex: 1,
    display: 'flex',
    minWidth: 0,
    borderTopLeftRadius: tokens.borderRadiusXLarge,
    overflow: 'hidden',
    boxShadow: tokens.shadow4,
  },
  centre: { flex: 1, display: 'grid', placeItems: 'center' },
});

export function App() {
  const styles = useStyles();
  const status = useApp((s) => s.status);
  const ready = useApp((s) => s.identity !== undefined);
  return (
    <div
      className={styles.root}
      data-testid="core-status"
      data-state={ready ? 'ready' : status.state}
    >
      <TitleBar />
      <div className={styles.body}>
        <AppRail />
        <div className={styles.content}>
          {status.state === 'error' ? (
            <div className={styles.centre}>
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>{strings.status.error}</MessageBarTitle>
                  {status.message}
                </MessageBarBody>
              </MessageBar>
            </div>
          ) : ready ? (
            <>
              <ListPane />
              <Home />
            </>
          ) : (
            <div className={styles.centre}>
              <Spinner label={strings.status.starting} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

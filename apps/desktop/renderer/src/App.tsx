import {
  makeStyles,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  tokens,
} from '@fluentui/react-components';
import { CallMini, CallStage } from './calls/CallStage.tsx';
import { useCall } from './calls/engine.ts';
import { IncomingCall } from './calls/IncomingCall.tsx';
import { Conversation } from './chat/Conversation.tsx';
import { FilesView } from './files/FilesView.tsx';
import { AppRail } from './shell/AppRail.tsx';
import { Home } from './shell/Home.tsx';
import { ListPane } from './shell/ListPane.tsx';
import { NetworkBanner } from './shell/NetworkBanner.tsx';
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
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    background: tokens.colorNeutralBackground1,
  },
});

export function App() {
  const styles = useStyles();
  const status = useApp((s) => s.status);
  const ready = useApp((s) => s.identity !== undefined);
  const rail = useApp((s) => s.rail);
  const selectedConv = useApp((s) => s.selectedConv);
  const inCall = useCall((s) => s.call !== null && s.call.state !== 'ringing');
  const callView = useCall((s) => s.view);
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
          ) : ready && inCall && callView === 'full' ? (
            <CallStage />
          ) : ready ? (
            <>
              <ListPane />
              <div className={styles.main}>
                <NetworkBanner />
                {rail === 'files' ? (
                  <FilesView />
                ) : (rail === 'chat' || rail === 'teams') && selectedConv ? (
                  <Conversation key={selectedConv} convId={selectedConv} />
                ) : (
                  <Home />
                )}
              </div>
            </>
          ) : (
            <div className={styles.centre}>
              <Spinner label={strings.status.starting} />
            </div>
          )}
        </div>
      </div>
      {ready && inCall && callView === 'mini' && <CallMini />}
      {ready && <IncomingCall />}
    </div>
  );
}

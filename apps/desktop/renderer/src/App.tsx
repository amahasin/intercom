import { useEffect } from 'react';
import {
  makeStyles,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  tokens,
} from '@fluentui/react-components';
import { CalendarView } from './calendar/Calendar.tsx';
import { useCalendar } from './calendar/calendarStore.ts';
import { initNav } from './shell/nav.ts';
import { initDoubleEscape } from './shell/doubleEscape.ts';
import { CallsView } from './calls/CallsView.tsx';
import { CallMessage } from './calls/IncomingCall.tsx';
import { RemoteHelpBanners } from './remote/RemoteHelp.tsx';
import { Conversation } from './chat/Conversation.tsx';
import { FilesView } from './files/FilesView.tsx';
import { AppRail } from './shell/AppRail.tsx';
import { CallBar } from './shell/CallBar.tsx';
import { EmptyPane } from './shell/EmptyPane.tsx';
import { PersonDetails } from './people/PersonDetails.tsx';
import { Home } from './shell/Home.tsx';
import { ListPane } from './shell/ListPane.tsx';
import { NetworkBanner } from './shell/NetworkBanner.tsx';
import { PreviewHost } from './preview/Viewer.tsx';
import { closePreview } from './preview/store.ts';
import { RequiredUpdate, UpdateBanner } from './shell/MoreSettings.tsx';
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
    position: 'relative',
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
  useEffect(initNav, []);
  useEffect(initDoubleEscape, []);
  const status = useApp((s) => s.status);
  const ready = useApp((s) => s.identity !== undefined);
  const rail = useApp((s) => s.rail);
  const selectedConv = useApp((s) => s.selectedConv);
  const selectedKind = useApp((s) =>
    s.selectedConv ? s.conversations[s.selectedConv]?.kind : undefined,
  );
  // A conversation opens in its own rail: Chat for chats and groups, Teams for channels.
  // Switching rails must not carry the other one's conversation along.
  const showConversation =
    selectedConv !== undefined &&
    ((rail === 'chat' && selectedKind !== 'channel') ||
      (rail === 'teams' && selectedKind === 'channel'));
  const calendarSidebar = useCalendar((s) => s.sidebar);
  // The file viewer covers the content; going somewhere else closes it.
  useEffect(closePreview, [rail, selectedConv]);
  return (
    <div
      className={styles.root}
      data-testid="core-status"
      data-state={ready ? 'ready' : status.state}
    >
      <TitleBar />
      {ready && <CallBar />}
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
              {rail !== 'files' && !(rail === 'calendar' && !calendarSidebar) && <ListPane />}
              <div className={styles.main}>
                <RemoteHelpBanners />
                <UpdateBanner />
                <RequiredUpdate />
                <NetworkBanner />
                {rail === 'files' ? (
                  <FilesView />
                ) : rail === 'calendar' ? (
                  <CalendarView />
                ) : showConversation ? (
                  <Conversation key={selectedConv} convId={selectedConv!} />
                ) : rail === 'chat' ? (
                  <Home />
                ) : rail === 'people' ? (
                  <PersonDetails />
                ) : rail === 'calls' ? (
                  <CallsView />
                ) : (
                  <EmptyPane rail={rail} />
                )}
              </div>
            </>
          ) : (
            <div className={styles.centre}>
              <Spinner label={strings.status.starting} />
            </div>
          )}
          <PreviewHost />
        </div>
      </div>
      {ready && <CallMessage />}
    </div>
  );
}

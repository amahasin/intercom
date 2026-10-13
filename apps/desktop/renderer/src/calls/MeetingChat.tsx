import { makeStyles, Spinner, Text, tokens } from '@fluentui/react-components';
import { ChatPane } from '../chat/ChatPane.tsx';
import { useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  panel: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
  },
  head: {
    padding: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  starting: { flex: 1, display: 'grid', placeItems: 'center' },
});

/**
 * The chat beside the call. It is the main window's chat (`ChatPane`), narrower, on the call's
 * conversation: the one-to-one chat while there are two people, the call's own group once there
 * are more. Nothing here is a chat of its own.
 */
export function MeetingChat({ convId }: { convId: string | undefined }) {
  const s = useStyles();
  const title = useApp((st) => (convId ? (st.conversations[convId]?.title ?? '') : ''));
  const known = useApp((st) => (convId ? st.conversations[convId] !== undefined : false));
  return (
    <aside className={s.panel} aria-label={strings.inCall.chat} data-testid="meeting-chat">
      <div className={s.head}>
        <Text weight="semibold">{title || strings.inCall.chat}</Text>
      </div>
      {convId && known ? (
        <ChatPane key={convId} convId={convId} compact ownDrop />
      ) : (
        <div className={s.starting} data-testid="meeting-chat-starting">
          <Spinner size="tiny" label={strings.inCall.chatStarting} />
        </div>
      )}
    </aside>
  );
}

import { makeStyles, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { useCall } from './engine.ts';

const useStyles = makeStyles({
  notice: { position: 'fixed', top: '64px', right: '20px', width: '360px', zIndex: 1100 },
});

/**
 * Short messages for the user in the main window (a call that could not start, for
 * example). Incoming calls ring in their own window: see IncomingWindow.
 */
export function CallMessage() {
  const s = useStyles();
  const message = useCall((st) => (st.all.length === 0 ? st.message : undefined));
  if (!message) return null;
  return (
    <div className={s.notice}>
      <MessageBar intent="info" data-testid="call-message">
        <MessageBarBody>{message}</MessageBarBody>
      </MessageBar>
    </div>
  );
}

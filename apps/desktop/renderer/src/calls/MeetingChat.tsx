import { useEffect, useLayoutEffect, useRef } from 'react';
import { makeStyles, Text, tokens } from '@fluentui/react-components';
import type { MessageView } from '@officemesh/protocol/ipc';
import { Composer } from '../chat/Composer.tsx';
import { MessageItem } from '../chat/MessageItem.tsx';
import { loadMessages, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  panel: {
    width: '340px',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
  },
  head: {
    padding: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  list: { flex: 1, overflowY: 'auto', minHeight: 0, paddingTop: tokens.spacingVerticalS },
});

const EMPTY: MessageView[] = [];

/** The meeting chat beside the call: the conversation's own log (plan section 9). */
export function MeetingChat({ convId }: { convId: string }) {
  const s = useStyles();
  const messages = useApp((st) => st.messages[convId] ?? EMPTY);
  const title = useApp((st) => st.conversations[convId]?.title ?? '');
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!useApp.getState().messages[convId]) void loadMessages(convId);
  }, [convId]);
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  return (
    <aside className={s.panel} aria-label={strings.inCall.chat} data-testid="meeting-chat">
      <div className={s.head}>
        <Text weight="semibold">{title || strings.inCall.chat}</Text>
      </div>
      <div ref={list} className={s.list}>
        {messages.slice(-200).map((m, i, all) => (
          <MessageItem
            key={m.id}
            message={m}
            firstOfRun={i === 0 || all[i - 1]!.author !== m.author}
            focused={false}
            variant="post"
          />
        ))}
      </div>
      <Composer convId={convId} placeholder={strings.chat.composePlaceholder(title)} />
    </aside>
  );
}

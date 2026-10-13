import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { makeStyles, Text, tokens } from '@fluentui/react-components';
import type { MessageView } from '@officemesh/protocol/ipc';
import { dayKey, dayLabel } from '../format.ts';
import { displayName, loadMessages, loadOlder, nameOf, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { queueFiles } from './attachments.ts';
import { useColumn } from './column.ts';
import { Composer } from './Composer.tsx';
import { MessageItem } from './MessageItem.tsx';
import { usePendingCount } from './outbox.ts';
import { PendingSends } from './PendingSends.tsx';
import { useFileDrop } from './useFileDrop.ts';

const useStyles = makeStyles({
  pane: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  scroller: { flex: 1, overflowY: 'auto', minHeight: 0 },
  intro: {
    padding: `${tokens.spacingVerticalXL} 0`,
    color: tokens.colorNeutralForeground3,
  },
  /** The label between days: plain, centred and quiet, like Teams. */
  day: {
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    padding: `${tokens.spacingVerticalL} 0 ${tokens.spacingVerticalXS}`,
  },
  status: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: `0 0 ${tokens.spacingVerticalXS}`,
  },
  below: {
    minHeight: '20px',
    padding: 0,
    color: tokens.colorNeutralForeground3,
  },
  drop: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    background: tokens.colorBrandBackground2,
    opacity: 0.92,
    border: `2px dashed ${tokens.colorBrandStroke1}`,
    zIndex: 20,
    pointerEvents: 'none',
  },
});

const EMPTY: MessageView[] = [];

/**
 * A conversation's messages and composer: the same pane in the main window and in the call
 * window (which only asks for `compact`, a narrower column). Everything the chat can do (bubbles,
 * day lines, delivery status, files, reactions, replies) is here once, so a change to the chat
 * is a change to both.
 */
export function ChatPane({
  convId,
  compact = false,
  ownDrop = false,
}: {
  convId: string;
  /** A narrow pane (the call window's side panel): less room for the pictures at the sides. */
  compact?: boolean;
  /** Take files dropped on the pane itself (the main window takes drops on the whole chat). */
  ownDrop?: boolean;
}) {
  const styles = useStyles();
  const column = useColumn();
  const conv = useApp((s) => s.conversations[convId]);
  const group = conv?.kind !== 'direct';
  const messages = useApp((s) => s.messages[convId] ?? EMPTY);
  const peerId = conv?.peerUserId;
  const person = useApp((s) => (peerId ? s.people[peerId] : undefined));
  const typing = useApp((s) => s.typing[convId]);
  const drop = useFileDrop((files) => queueFiles(convId, files), ownDrop);
  const [now, setNow] = useState(() => Date.now());
  const name = peerId ? nameOf(person, peerId) : (conv?.title ?? '');
  const narrow = compact ? column.callChat : column.chat;

  // The call window opens on a conversation nobody has looked at in this window yet.
  useEffect(() => {
    if (!useApp.getState().messages[convId]) void loadMessages(convId);
  }, [convId]);

  // Re-render each second while someone is typing, so the indicator expires.
  useEffect(() => {
    if (!typing) return;
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, [typing]);
  const typers = Object.entries(typing ?? {})
    .filter(([, until]) => until > now)
    .map(([id]) => (id === peerId ? name : displayName(id)));

  return (
    <div className={styles.pane} {...(ownDrop ? drop.bind : {})} data-testid="chat-pane">
      <MessageList
        convId={convId}
        messages={messages}
        name={name}
        direct={!group}
        columnClass={narrow}
      />
      <div className={narrow}>
        <Text block size={200} className={styles.below} data-testid="typing-indicator">
          {typers.length > 0
            ? strings.typing(typers)
            : person && !person.online
              ? strings.chat.offlineNote(name)
              : ''}
        </Text>
        {conv?.active === false ? (
          <Text block size={200} className={styles.below} data-testid="not-member">
            {strings.groups.notMember}
          </Text>
        ) : (
          <Composer convId={convId} placeholder={strings.chat.composePlaceholder(name)} flush />
        )}
      </div>
      {ownDrop && drop.dragging && (
        <div className={styles.drop}>
          <Text size={500} weight="semibold">
            {strings.compose.dropHere}
          </Text>
        </div>
      )}
    </div>
  );
}

function MessageList({
  convId,
  messages,
  name,
  direct,
  columnClass,
}: {
  convId: string;
  messages: MessageView[];
  name: string;
  direct: boolean;
  columnClass: string;
}) {
  const styles = useStyles();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const focus = useApp((s) => (s.focusMessage?.convId === convId ? s.focusMessage.id : undefined));
  const lastMine = [...messages].reverse().find((m) => m.mine);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    getItemKey: (i) => messages[i]!.id,
    overscan: 12,
  });

  // Taller than first guessed (a file card, a picture): still at the bottom if it was.
  const totalHeight = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    if (focus) return;
    if (atBottom.current && messages.length > 0)
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
  }, [messages.length, totalHeight, virtualizer, focus]);

  // A file just sent shows at the bottom while it is prepared: go there to see it.
  const pending = usePendingCount(convId);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (pending === 0 || !el) return;
    atBottom.current = true;
    el.scrollTop = el.scrollHeight;
  }, [pending]);

  // Jump to a search hit, activity item or toast target.
  useEffect(() => {
    if (!focus) return;
    const i = messages.findIndex((m) => m.id === focus);
    if (i < 0) return;
    atBottom.current = false;
    virtualizer.scrollToIndex(i, { align: 'center' });
    const t = window.setTimeout(() => useApp.setState({ focusMessage: undefined }), 2_500);
    return () => window.clearTimeout(t);
  }, [focus, messages, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40 && messages.length >= 200) void loadOlder(convId);
  };

  return (
    <div
      ref={scrollRef}
      className={styles.scroller}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      data-testid="message-list"
    >
      <div className={columnClass}>
        {messages.length === 0 && (
          <Text as="p" className={styles.intro}>
            {strings.chat.startOfChat(name)}
          </Text>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const m = messages[item.index]!;
            const prev = messages[item.index - 1];
            const newDay = !prev || dayKey(prev.at) !== dayKey(m.at);
            const firstOfRun = newDay || prev.author !== m.author || m.at - prev.at > 5 * 60_000;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {newDay && (
                  <Text block size={200} className={styles.day} data-testid="day-separator">
                    {dayLabel(m.at)}
                  </Text>
                )}
                <MessageItem
                  message={m}
                  name={direct ? name : undefined}
                  firstOfRun={firstOfRun}
                  focused={focus === m.id}
                />
                {m === lastMine &&
                  m.status &&
                  !(m.file && direct && (m.status === 'waiting' || m.status === 'carried')) && (
                    <div className={styles.status}>
                      <Text
                        size={200}
                        className={styles.muted}
                        data-testid="delivery-status"
                        data-status={m.status}
                      >
                        {m.status === 'waiting'
                          ? direct
                            ? strings.chat.status.waiting(name)
                            : strings.chat.status.sending
                          : m.status === 'carried'
                            ? strings.chat.status.carried(name)
                            : m.status === 'read'
                              ? strings.message.status.seen
                              : strings.chat.status[m.status]}
                      </Text>
                    </div>
                  )}
              </div>
            );
          })}
        </div>
        <PendingSends convId={convId} />
      </div>
    </div>
  );
}

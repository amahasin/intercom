import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Avatar,
  Badge,
  Button,
  makeStyles,
  mergeClasses,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { Send20Filled } from '@fluentui/react-icons';
import type { MessageView, PersonView } from '@officemesh/protocol/ipc';
import { MAX_MESSAGE_TEXT } from '@officemesh/protocol';
import { presenceBadge, shortTime } from '../format.ts';
import { ProfileCard } from '../people/ProfileCard.tsx';
import { loadOlder, nameOf, sendMessage, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  root: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    background: tokens.colorNeutralBackground1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headerText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  avatarButton: {
    border: 'none',
    background: 'transparent',
    padding: 0,
    cursor: 'pointer',
    borderRadius: '50%',
  },
  muted: { color: tokens.colorNeutralForeground3 },
  scroller: { flex: 1, overflowY: 'auto', minHeight: 0, userSelect: 'text' },
  intro: {
    padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalXXL}`,
    color: tokens.colorNeutralForeground3,
  },
  row: { display: 'flex', padding: `2px ${tokens.spacingHorizontalXXL}` },
  mineRow: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '68%',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground3,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  mineBubble: { background: tokens.colorBrandBackground2 },
  meta: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground3,
  },
  status: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: `0 ${tokens.spacingHorizontalXXL} ${tokens.spacingVerticalXS}`,
  },
  composer: {
    display: 'flex',
    alignItems: 'flex-end',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalL}`,
  },
  textarea: { flex: 1 },
  offline: { padding: `0 ${tokens.spacingHorizontalXL}`, color: tokens.colorNeutralForeground3 },
});

const EMPTY: MessageView[] = [];

export function Conversation({ convId }: { convId: string }) {
  const styles = useStyles();
  const conv = useApp((s) => s.conversations[convId]);
  const messages = useApp((s) => s.messages[convId] ?? EMPTY);
  const peerId = conv?.peerUserId;
  const person = useApp((s) => (peerId ? s.people[peerId] : undefined));
  const name = peerId ? nameOf(person, peerId) : (conv?.title ?? '');

  return (
    <section className={styles.root} aria-label={name} data-testid="conversation">
      <header className={styles.header} data-testid="conversation-header">
        {person && <PersonAvatar person={person} name={name} />}
        <div className={styles.headerText}>
          <Text size={400} weight="semibold">
            {name}{' '}
            {person?.trust === 'new-device' && (
              <Badge color="warning" appearance="tint" data-testid="header-new-device">
                {strings.person.unverifiedBadge}
              </Badge>
            )}
          </Text>
          <Text size={200} className={styles.muted} data-testid="header-presence">
            {person ? strings.presence[person.presence] : ''}
            {person?.statusMessage ? ` · ${person.statusMessage}` : ''}
          </Text>
        </div>
      </header>
      <MessageList convId={convId} messages={messages} name={name} />
      {person && !person.online && (
        <Text size={200} className={styles.offline} data-testid="offline-note">
          {strings.chat.offlineNote(name)}
        </Text>
      )}
      <Composer convId={convId} name={name} />
    </section>
  );
}

function PersonAvatar({ person, name }: { person: PersonView; name: string }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(_e, d) => setOpen(d.open)}
      withArrow
      positioning="below-start"
    >
      <PopoverTrigger disableButtonEnhancement>
        <button
          type="button"
          className={styles.avatarButton}
          aria-label={strings.person.profileCard(name)}
          data-testid="open-profile-card"
        >
          <Avatar name={name} size={40} color="colorful" badge={presenceBadge(person.presence)} />
        </button>
      </PopoverTrigger>
      {/* Rendered only while open: Fluent's exit motion can stall when the card's own
          content changes as it closes (Accept), leaving a closed card on screen. */}
      {open ? (
        <PopoverSurface>
          <ProfileCard person={person} onClose={() => setOpen(false)} />
        </PopoverSurface>
      ) : (
        <></>
      )}
    </Popover>
  );
}

function MessageList({
  convId,
  messages,
  name,
}: {
  convId: string;
  messages: MessageView[];
  name: string;
}) {
  const styles = useStyles();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastMine = [...messages].reverse().find((m) => m.mine);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    getItemKey: (i) => messages[i]!.id,
    overscan: 12,
  });

  // Stick to the newest message unless the user has scrolled up to read history.
  useLayoutEffect(() => {
    if (atBottom.current && messages.length > 0)
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
  }, [messages.length, virtualizer]);

  useEffect(() => {
    atBottom.current = true;
  }, [convId]);

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
      {messages.length === 0 && (
        <Text as="p" className={styles.intro}>
          {strings.chat.startOfChat(name)}
        </Text>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const m = messages[item.index]!;
          const prev = messages[item.index - 1];
          const firstOfRun = !prev || prev.author !== m.author || m.at - prev.at > 5 * 60_000;
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
              <div
                className={mergeClasses(styles.row, m.mine && styles.mineRow)}
                style={{ paddingTop: firstOfRun ? 10 : 2 }}
              >
                <div
                  className={mergeClasses(styles.bubble, m.mine && styles.mineBubble)}
                  data-testid="message"
                  data-mine={m.mine}
                  data-status={m.status}
                >
                  {firstOfRun && (
                    <Text
                      size={200}
                      className={styles.meta}
                      style={{ marginTop: 0, marginBottom: 2 }}
                      block
                    >
                      {m.mine ? strings.chat.you : name} · {shortTime(m.at)}
                    </Text>
                  )}
                  <Text>{m.text}</Text>
                </div>
              </div>
              {m === lastMine && m.status && (
                <div className={styles.status}>
                  <Text
                    size={200}
                    className={styles.muted}
                    data-testid="delivery-status"
                    data-status={m.status}
                  >
                    {m.status === 'waiting'
                      ? strings.chat.status.waiting(name)
                      : strings.chat.status[m.status]}
                  </Text>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Composer({ convId, name }: { convId: string; name: string }) {
  const styles = useStyles();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The conversation view is keyed by convId, so each chat mounts with an empty composer.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = async () => {
    const body = text;
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      await sendMessage(convId, body);
      setText('');
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className={styles.composer}>
      <Textarea
        ref={inputRef}
        className={styles.textarea}
        resize="vertical"
        placeholder={strings.chat.composePlaceholder(name)}
        aria-label={strings.chat.composePlaceholder(name)}
        aria-description={strings.chat.sendHint}
        value={text}
        maxLength={MAX_MESSAGE_TEXT}
        onChange={(_e, d) => setText(d.value)}
        onKeyDown={onKeyDown}
        data-testid="composer"
      />
      <Button
        appearance="primary"
        icon={<Send20Filled />}
        aria-label={strings.chat.send}
        disabled={!text.trim() || sending}
        onClick={() => void send()}
        data-testid="send"
      />
    </div>
  );
}

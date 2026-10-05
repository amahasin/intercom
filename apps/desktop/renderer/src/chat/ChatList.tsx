import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Avatar,
  CounterBadge,
  Input,
  makeStyles,
  mergeClasses,
  Text,
  tokens,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import type { ConversationView, PersonView } from '@officemesh/protocol/ipc';
import { presenceBadge, shortTime } from '../format.ts';
import { avatarSrc, nameOf, openChatWith, selectConversation, useApp } from '../state.ts';
import { strings } from '../strings.ts';

type Row =
  | { kind: 'header'; key: string; label: string; detail?: string }
  | { kind: 'conv'; key: string; conv: ConversationView; person: PersonView | undefined }
  | { kind: 'person'; key: string; person: PersonView }
  | { kind: 'note'; key: string; text: string };

const ROW_HEIGHT = { header: 36, conv: 60, person: 48, note: 64 } as const;

const useStyles = makeStyles({
  root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  find: { margin: `0 ${tokens.spacingHorizontalM} ${tokens.spacingVerticalS}` },
  scroller: { flex: 1, overflowY: 'auto', minHeight: 0 },
  header: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    padding: `0 ${tokens.spacingHorizontalL} ${tokens.spacingVerticalXS}`,
    color: tokens.colorNeutralForeground3,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    width: 'calc(100% - 16px)',
    margin: '0 8px',
    padding: `0 ${tokens.spacingHorizontalS}`,
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}` },
  },
  selected: { background: tokens.colorSubtleBackgroundSelected },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  line: { display: 'flex', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalS },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  note: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    color: tokens.colorNeutralForeground3,
  },
});

function sortPeople(a: PersonView, b: PersonView): number {
  if (a.online !== b.online) return a.online ? -1 : 1;
  return nameOf(a, a.userId).localeCompare(nameOf(b, b.userId));
}

export function ChatList() {
  const styles = useStyles();
  const people = useApp((s) => s.people);
  const conversations = useApp((s) => s.conversations);
  const selectedConv = useApp((s) => s.selectedConv);
  const selfId = useApp((s) => s.identity?.userId);
  const [filter, setFilter] = useState('');
  const findRef = useRef<HTMLInputElement>(null);

  // Ctrl+N: start a new chat by finding a colleague.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        findRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rows = useMemo<Row[]>(() => {
    const needle = filter.trim().toLowerCase();
    const matches = (p: PersonView | undefined, id: string) =>
      !needle || nameOf(p, id).toLowerCase().includes(needle);
    const out: Row[] = [];
    const convs = Object.values(conversations)
      .filter(
        (c) =>
          c.peerUserId && c.peerUserId !== selfId && matches(people[c.peerUserId], c.peerUserId),
      )
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    if (convs.length > 0) {
      out.push({ kind: 'header', key: 'h-chats', label: strings.chat.chats });
      for (const conv of convs)
        out.push({ kind: 'conv', key: `c-${conv.convId}`, conv, person: people[conv.peerUserId!] });
    }
    const everyone = Object.values(people).filter((p) => p.userId !== selfId);
    const shown = everyone.filter((p) => matches(p, p.userId)).sort(sortPeople);
    const online = everyone.filter((p) => p.online).length;
    out.push({
      kind: 'header',
      key: 'h-people',
      label: strings.chat.people,
      detail: strings.chat.online(online),
    });
    if (everyone.length === 0) out.push({ kind: 'note', key: 'n-none', text: strings.chat.nobody });
    else if (shown.length === 0)
      out.push({ kind: 'note', key: 'n-match', text: strings.chat.noMatch });
    for (const person of shown) out.push({ kind: 'person', key: `p-${person.userId}`, person });
    return out;
  }, [people, conversations, filter, selfId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ROW_HEIGHT[rows[i]!.kind],
    getItemKey: (i) => rows[i]!.key,
    overscan: 10,
  });

  return (
    <div className={styles.root}>
      <Input
        ref={findRef}
        className={styles.find}
        contentBefore={<Search20Regular />}
        placeholder={`${strings.chat.find} (${strings.chat.findShortcut})`}
        aria-label={strings.chat.find}
        value={filter}
        onChange={(_e, d) => setFilter(d.value)}
        data-testid="people-filter"
      />
      <div ref={scrollRef} className={styles.scroller} data-testid="chat-list">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {renderRow(row)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  function renderRow(row: Row) {
    switch (row.kind) {
      case 'header':
        return (
          <div className={styles.header} style={{ height: '100%' }}>
            <Text size={200} weight="semibold">
              {row.label}
            </Text>
            {row.detail && <Text size={200}>{row.detail}</Text>}
          </div>
        );
      case 'note':
        return (
          <Text as="p" size={200} className={styles.note}>
            {row.text}
          </Text>
        );
      case 'conv': {
        const userId = row.conv.peerUserId!;
        const name = nameOf(row.person, userId);
        const last = row.conv.lastMessage;
        return (
          <button
            type="button"
            className={mergeClasses(
              styles.row,
              selectedConv === row.conv.convId && styles.selected,
            )}
            style={{ height: ROW_HEIGHT.conv - 4 }}
            onClick={() => void selectConversation(row.conv.convId)}
            aria-current={selectedConv === row.conv.convId ? 'true' : undefined}
            data-testid={`conv-${userId}`}
          >
            <Avatar
              name={name}
              size={36}
              color="colorful"
              image={avatarSrc(row.person?.avatarHash)}
              badge={presenceBadge(row.person?.presence ?? 'offline')}
            />
            <span className={styles.text}>
              <span className={styles.line}>
                <Text weight="semibold" className={styles.ellipsis}>
                  {name}
                </Text>
                {row.conv.unread > 0 && row.conv.notify !== 'muted' && (
                  <CounterBadge
                    count={row.conv.unread}
                    size="small"
                    color="brand"
                    data-testid="conv-unread"
                  />
                )}
                {last && (
                  <Text size={200} className={styles.muted}>
                    {shortTime(last.at)}
                  </Text>
                )}
              </span>
              <Text size={200} className={mergeClasses(styles.ellipsis, styles.muted)}>
                {last
                  ? `${last.author === selfId ? `${strings.chat.you}: ` : ''}${last.text}`
                  : strings.chat.noMessagesYet}
              </Text>
            </span>
          </button>
        );
      }
      case 'person': {
        const { person } = row;
        const name = nameOf(person, person.userId);
        return (
          <button
            type="button"
            className={styles.row}
            style={{ height: ROW_HEIGHT.person - 4 }}
            onClick={() => void openChatWith(person.userId)}
            data-testid={`person-${person.userId}`}
            data-online={person.online}
            aria-label={`${name}, ${strings.presence[person.presence]}`}
          >
            <Avatar
              name={name}
              size={32}
              color="colorful"
              image={avatarSrc(person.avatarHash)}
              badge={presenceBadge(person.presence)}
            />
            <span className={styles.text}>
              <Text className={styles.ellipsis}>{name}</Text>
              <Text size={200} className={mergeClasses(styles.ellipsis, styles.muted)}>
                {person.statusMessage || person.jobTitle || strings.presence[person.presence]}
              </Text>
            </span>
          </button>
        );
      }
    }
  }
}

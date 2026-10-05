import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Avatar,
  Badge,
  Button,
  makeStyles,
  Menu,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  Alert20Regular,
  AlertOff20Regular,
  Call20Regular,
  MoreHorizontal20Regular,
  People20Regular,
  Pin20Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import type { MessageView, PersonView } from '@officemesh/protocol/ipc';
import { startCall, useCall } from '../calls/engine.ts';
import { presenceBadge } from '../format.ts';
import { ProfileCard } from '../people/ProfileCard.tsx';
import { MembersPanel } from '../people/MembersPanel.tsx';
import { Channel } from '../teams/Channel.tsx';
import {
  avatarSrc,
  core,
  displayName,
  loadOlder,
  nameOf,
  openAt,
  putConversation,
  selectConversation,
  useApp,
} from '../state.ts';
import { strings } from '../strings.ts';
import { Composer, shareFiles } from './Composer.tsx';
import { TextDialog } from './GroupDialogs.tsx';
import { MessageItem } from './MessageItem.tsx';

const useStyles = makeStyles({
  root: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    background: tokens.colorNeutralBackground1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headerText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  avatarButton: {
    border: 'none',
    background: 'transparent',
    padding: 0,
    cursor: 'pointer',
    borderRadius: '50%',
  },
  muted: { color: tokens.colorNeutralForeground3 },
  scroller: { flex: 1, overflowY: 'auto', minHeight: 0 },
  intro: {
    padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalXXL}`,
    color: tokens.colorNeutralForeground3,
  },
  status: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: `0 ${tokens.spacingHorizontalXXL} ${tokens.spacingVerticalXS}`,
  },
  below: {
    minHeight: '20px',
    padding: `0 ${tokens.spacingHorizontalXL}`,
    color: tokens.colorNeutralForeground3,
  },
  pinnedList: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    maxWidth: '360px',
    maxHeight: '320px',
    overflowY: 'auto',
  },
  pinnedItem: {
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { background: tokens.colorSubtleBackgroundHover },
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

export function Conversation({ convId }: { convId: string }) {
  const kind = useApp((s) => s.conversations[convId]?.kind);
  return kind === 'channel' ? <Channel convId={convId} /> : <Chat convId={convId} />;
}

function Chat({ convId }: { convId: string }) {
  const styles = useStyles();
  const conv = useApp((s) => s.conversations[convId]);
  const group = conv?.kind === 'group';
  const messages = useApp((s) => s.messages[convId] ?? EMPTY);
  const peerId = conv?.peerUserId;
  const person = useApp((s) => (peerId ? s.people[peerId] : undefined));
  const typing = useApp((s) => s.typing[convId]);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const name = peerId ? nameOf(person, peerId) : (conv?.title ?? '');

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
    <section
      className={styles.root}
      aria-label={name}
      data-testid="conversation"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void shareFiles(convId, [...e.dataTransfer.files]);
      }}
    >
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
            {group ? strings.groups.members(conv.memberCount) : ''}
          </Text>
        </div>
        {(conv?.kind === 'direct' || (group && conv.active)) && <CallButtons convId={convId} />}
        {group && conv.active && <GroupButtons convId={convId} title={name} />}
        <PinnedButton convId={convId} name={name} />
        <NotifyMenu convId={convId} />
      </header>
      <MessageList convId={convId} messages={messages} name={name} direct={!group} />
      <Text size={200} className={styles.below} data-testid="typing-indicator">
        {typers.length > 0
          ? strings.typing(typers)
          : person && !person.online
            ? strings.chat.offlineNote(name)
            : ''}
      </Text>
      {conv?.active === false ? (
        <Text size={200} className={styles.below} data-testid="not-member">
          {strings.groups.notMember}
        </Text>
      ) : (
        <Composer convId={convId} placeholder={strings.chat.composePlaceholder(name)} />
      )}
      {dragging && (
        <div className={styles.drop}>
          <Text size={500} weight="semibold">
            {strings.compose.dropHere}
          </Text>
        </div>
      )}
    </section>
  );
}

/** Video and audio call buttons: everyone else in the chat is rung. */
function CallButtons({ convId }: { convId: string }) {
  const conv = useApp((s) => s.conversations[convId]);
  const selfId = useApp((s) => s.identity?.userId);
  const inCall = useCall((s) => s.call !== null);
  const [members, setMembers] = useState<string[]>([]);
  const memberCount = conv?.memberCount;
  useEffect(() => {
    if (conv?.kind === 'direct') return;
    void core
      .invoke('conversations.members', { convId })
      .then((list) => setMembers(list.map((m) => m.userId)));
  }, [convId, conv?.kind, memberCount]);
  const others = conv?.kind === 'direct' ? [conv.peerUserId!] : members.filter((u) => u !== selfId);
  const tooMany = others.length + 1 > 12;
  const videoTooMany = others.length + 1 > 8;
  const call = (media: 'audio' | 'video') => void startCall(others, media, convId);
  return (
    <>
      <Tooltip
        content={videoTooMany ? strings.calls.tooMany : strings.calls.videoCall}
        relationship="label"
      >
        <Button
          appearance="subtle"
          icon={<Video20Regular />}
          disabled={inCall || videoTooMany || others.length === 0}
          onClick={() => call('video')}
          data-testid="start-video-call"
        />
      </Tooltip>
      <Tooltip
        content={tooMany ? strings.calls.tooMany : strings.calls.audioCall}
        relationship="label"
      >
        <Button
          appearance="subtle"
          icon={<Call20Regular />}
          disabled={inCall || tooMany || others.length === 0}
          onClick={() => call('audio')}
          data-testid="start-audio-call"
        />
      </Tooltip>
    </>
  );
}

function GroupButtons({ convId, title }: { convId: string; title: string }) {
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <Popover positioning="below-end" withArrow>
        <PopoverTrigger disableButtonEnhancement>
          <Button
            appearance="subtle"
            icon={<People20Regular />}
            aria-label={strings.groups.manage}
            data-testid="group-people"
          />
        </PopoverTrigger>
        <PopoverSurface style={{ width: 360, maxHeight: 480, overflowY: 'auto', padding: 0 }}>
          <MembersPanel convId={convId} manage />
        </PopoverSurface>
      </Popover>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            appearance="subtle"
            icon={<MoreHorizontal20Regular />}
            aria-label={strings.message.more}
            data-testid="group-more"
          />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem onClick={() => setRenaming(true)} data-testid="group-rename">
              {strings.groups.rename}
            </MenuItem>
            <MenuItem
              data-testid="group-leave"
              onClick={() => {
                if (!window.confirm(strings.groups.leaveConfirm)) return;
                void core
                  .invoke('conversations.leave', { convId })
                  .then(() => selectConversation(undefined));
              }}
            >
              {strings.groups.leave}
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      {renaming && (
        <TextDialog
          title={strings.groups.renameTitle}
          label={strings.groups.groupName}
          initial={title}
          onClose={() => setRenaming(false)}
          onSubmit={(t) =>
            core.invoke('conversations.rename', { convId, title: t }).then(putConversation)
          }
        />
      )}
    </>
  );
}

function PinnedButton({ convId, name }: { convId: string; name: string }) {
  const styles = useStyles();
  const [pinned, setPinned] = useState<MessageView[]>([]);
  return (
    <Popover
      onOpenChange={(_e, d) => {
        if (d.open) void core.invoke('messages.pinned', { convId }).then(setPinned);
      }}
      positioning="below-end"
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          icon={<Pin20Regular />}
          aria-label={strings.message.pinned}
          data-testid="pinned-button"
        />
      </PopoverTrigger>
      <PopoverSurface>
        <div className={styles.pinnedList} data-testid="pinned-list">
          {pinned.length === 0 && <Text size={200}>{strings.activity.empty}</Text>}
          {pinned.map((m) => (
            <button
              key={m.id}
              type="button"
              className={styles.pinnedItem}
              onClick={() => void openAt(convId, m)}
            >
              <Text size={200} weight="semibold" block>
                {m.mine ? strings.chat.you : name}
              </Text>
              <Text size={200}>{m.text.slice(0, 120) || m.file?.name}</Text>
            </button>
          ))}
        </div>
      </PopoverSurface>
    </Popover>
  );
}

function NotifyMenu({ convId }: { convId: string }) {
  const level = useApp((s) => s.conversations[convId]?.notify ?? 'all');
  return (
    <Menu
      checkedValues={{ notify: [level] }}
      onCheckedValueChange={(_e, d) =>
        void core
          .invoke('notifications.setLevel', {
            convId,
            level: d.checkedItems[0] as 'all' | 'mentions' | 'muted',
          })
          .then((c) =>
            useApp.setState((s) => ({ conversations: { ...s.conversations, [c.convId]: c } })),
          )
      }
    >
      <MenuTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          icon={level === 'muted' ? <AlertOff20Regular /> : <Alert20Regular />}
          aria-label={strings.notify.label}
          data-testid="notify-menu"
        />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItemRadio name="notify" value="all">
            {strings.notify.all}
          </MenuItemRadio>
          <MenuItemRadio name="notify" value="mentions">
            {strings.notify.mentions}
          </MenuItemRadio>
          <MenuItemRadio name="notify" value="muted" data-testid="notify-muted">
            {strings.notify.muted}
          </MenuItemRadio>
        </MenuList>
      </MenuPopover>
    </Menu>
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
          <Avatar
            name={name}
            size={40}
            color="colorful"
            image={avatarSrc(person.avatarHash)}
            badge={presenceBadge(person.presence)}
          />
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
  direct,
}: {
  convId: string;
  messages: MessageView[];
  name: string;
  direct: boolean;
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

  useLayoutEffect(() => {
    if (focus) return;
    if (atBottom.current && messages.length > 0)
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
  }, [messages.length, virtualizer, focus]);

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
              <MessageItem
                message={m}
                name={direct ? name : undefined}
                firstOfRun={firstOfRun}
                focused={focus === m.id}
              />
              {m === lastMine && m.status && (
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
    </div>
  );
}

import { RemoteHelpButton } from '../remote/RemoteHelp.tsx';
import { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  makeStyles,
  mergeClasses,
  Menu,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Tab,
  TabList,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  Alert20Regular,
  AlertOff20Regular,
  Call20Regular,
  Megaphone24Regular,
  MoreHorizontal20Regular,
  People20Regular,
  Pin20Regular,
  Video20Regular,
  VideoPerson20Regular,
} from '@fluentui/react-icons';
import type { ConversationView, MessageView, PersonView } from '@officemesh/protocol/ipc';
import { joinMeeting, meetNow, startCall, useCall } from '../calls/engine.ts';
import { FilesTable } from '../files/FilesView.tsx';
import { presenceBadge, presenceLine } from '../format.ts';
import { GroupAvatar, groupPictureFrom } from './GroupAvatar.tsx';
import { GroupHover, ProfileHover, type Trigger } from '../people/ProfileHover.tsx';
import { MembersPanel } from '../people/MembersPanel.tsx';
import { Channel } from '../teams/Channel.tsx';
import {
  avatarSrc,
  core,
  nameOf,
  openAt,
  putConversation,
  selectConversation,
  useApp,
} from '../state.ts';
import { strings } from '../strings.ts';
import { queueFiles } from './attachments.ts';
import { useFileDrop } from './useFileDrop.ts';
import { ChatPane } from './ChatPane.tsx';
import { TextDialog } from './GroupDialogs.tsx';

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
    // The same height whether or not there is a person's avatar, so the line under it and the
    // tabs sit in the same place in every chat.
    minHeight: '68px',
    boxSizing: 'border-box',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tabs: { marginLeft: tokens.spacingHorizontalL },
  spacer: { flex: 1 },
  shared: { flex: 1, minHeight: 0, overflowY: 'auto', padding: tokens.spacingHorizontalL },
  headerText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '0 1 auto' },
  // The name and its badge stay on one line and shorten with an ellipsis, never over each other.
  nameLine: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  clipped: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  badge: { flexShrink: 1000, minWidth: 0, maxWidth: '100%' },
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

export function Conversation({ convId }: { convId: string }) {
  const kind = useApp((s) => s.conversations[convId]?.kind);
  return kind === 'channel' ? <Channel convId={convId} /> : <Chat convId={convId} />;
}

function Chat({ convId }: { convId: string }) {
  const styles = useStyles();
  const conv = useApp((s) => s.conversations[convId]);
  const broadcast = conv?.broadcast === true;
  // Who is on the network now (and this user): the channel keeps everyone ever seen, which is
  // not who is there to read it.
  const online = useApp((s) => Object.values(s.people).filter((p) => p.online).length + 1);
  const group = conv?.kind === 'group' && !broadcast;
  const peerId = conv?.peerUserId;
  const person = useApp((s) => (peerId ? s.people[peerId] : undefined));
  const drop = useFileDrop((files) => queueFiles(convId, files));
  const dragging = drop.dragging;
  const [tab, setTab] = useState<'chat' | 'shared'>('chat');
  const name = peerId ? nameOf(person, peerId) : (conv?.title ?? '');

  return (
    <section className={styles.root} aria-label={name} data-testid="conversation" {...drop.bind}>
      <header className={styles.header} data-testid="conversation-header">
        {person && <PersonAvatar person={person} name={name} />}
        {broadcast && (
          <Avatar
            icon={<Megaphone24Regular />}
            size={40}
            color="brand"
            shape="square"
            data-testid="broadcast-avatar"
          />
        )}
        {!person && group && (
          <GroupHover conv={conv}>
            <span className={styles.avatarButton}>
              <GroupAvatar title={name} picture={conv.picture} size={40} />
            </span>
          </GroupHover>
        )}
        <Titled person={person} conv={group ? conv : undefined}>
          <div className={styles.headerText} data-testid="header-title">
            <div className={styles.nameLine}>
              <Text size={400} weight="semibold" className={styles.clipped}>
                {name}
              </Text>
              {person?.trust === 'new-device' && (
                <Badge
                  color="warning"
                  appearance="tint"
                  className={styles.badge}
                  data-testid="header-new-device"
                >
                  <span className={styles.clipped}>{strings.person.unverifiedBadge}</span>
                </Badge>
              )}
            </div>
            {/* The status dot is on the avatar; the status message is on the person's card. */}
            <Text
              size={200}
              className={mergeClasses(styles.muted, styles.clipped)}
              data-testid="header-presence"
            >
              {person ? presenceLine(person) : ''}
              {group ? strings.groups.members(conv.memberCount) : ''}
              {broadcast ? strings.broadcast.subtitle(online) : ''}
            </Text>
          </div>
        </Titled>
        <TabList
          className={styles.tabs}
          size="small"
          selectedValue={tab}
          onTabSelect={(_e, d) => setTab(d.value as 'chat' | 'shared')}
          data-testid="conversation-tabs"
        >
          <Tab value="chat" data-testid="tab-chat">
            {strings.chat.tabs.chat}
          </Tab>
          <Tab value="shared" data-testid="tab-shared">
            {strings.chat.tabs.shared}
          </Tab>
        </TabList>
        <span className={styles.spacer} />
        {conv?.kind === 'direct' && conv.peerUserId && <RemoteHelpButton peer={conv.peerUserId} />}
        {(conv?.kind === 'direct' || (group && conv.active)) && <CallButtons convId={convId} />}
        {group && conv.active && <GroupButtons convId={convId} title={name} />}
        <PinnedButton convId={convId} name={name} />
        <NotifyMenu convId={convId} />
      </header>
      {tab === 'shared' && (
        <div className={styles.shared} data-testid="shared-files">
          <FilesTable convId={convId} />
        </div>
      )}
      {tab === 'chat' && <ChatPane convId={convId} />}
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
  // A call going on in this group, announced by a card in the chat: anyone in the group can join.
  const liveCard = useApp((s) =>
    conv?.kind === 'direct' ? undefined : s.messages[convId]?.findLast((m) => m.callCard),
  );
  // When the window opened: a card older than the core's own 12 hours is a call that died unnoticed.
  const [opened] = useState(() => Date.now());
  const liveCall =
    liveCard && !liveCard.callCard?.ended && opened - liveCard.at < 12 * 60 * 60 * 1000
      ? liveCard
      : undefined;
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
      {liveCall && !inCall && (
        <Button
          appearance="primary"
          icon={<Video20Regular />}
          onClick={() => void joinMeeting(convId, { author: liveCall.author, seq: liveCall.seq })}
          data-testid="join-call"
        >
          {strings.meetings.joinCall}
        </Button>
      )}
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
      {conv?.kind === 'group' && (
        <Button
          appearance="subtle"
          icon={<VideoPerson20Regular />}
          disabled={inCall}
          onClick={() => void meetNow(convId, 'video')}
          data-testid="meet-now"
        >
          {strings.meetings.meetNow}
        </Button>
      )}
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
  const picture = useApp((s) => s.conversations[convId]?.picture);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pictureError, setPictureError] = useState('');
  const setPicture = (data: string) =>
    core.invoke('conversations.setPicture', { convId, picture: data }).then(putConversation);
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        data-testid="group-picture-input"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            setPictureError('');
            await setPicture(await groupPictureFrom(file));
          } catch {
            setPictureError(strings.groups.pictureFailed);
          }
        }}
      />
      {pictureError && (
        <Text size={200} role="alert" data-testid="group-picture-error">
          {pictureError}
        </Text>
      )}
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
            <MenuItem onClick={() => fileInput.current?.click()} data-testid="group-picture">
              {strings.groups.changePicture}
            </MenuItem>
            {picture && (
              <MenuItem onClick={() => void setPicture('')} data-testid="group-picture-remove">
                {strings.groups.removePicture}
              </MenuItem>
            )}
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

/** The title of a chat shows the person's (or the group's) card when it is hovered. */
function Titled({
  person,
  conv,
  children,
}: {
  person: PersonView | undefined;
  conv: ConversationView | undefined;
  children: Trigger;
}) {
  if (person)
    return (
      <ProfileHover person={person} primary="profile">
        {children}
      </ProfileHover>
    );
  if (conv) return <GroupHover conv={conv}>{children}</GroupHover>;
  return children;
}

function PersonAvatar({ person, name }: { person: PersonView; name: string }) {
  const styles = useStyles();
  return (
    <ProfileHover person={person} primary="profile">
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
    </ProfileHover>
  );
}

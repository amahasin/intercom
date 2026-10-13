import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  makeStyles,
  MessageBar,
  MessageBarBody,
  mergeClasses,
  Tab,
  TabList,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  ChevronDown16Regular,
  ChevronUp16Regular,
  VideoPerson20Regular,
} from '@fluentui/react-icons';
import { meetNow, useCall } from '../calls/engine.ts';
import type { MessageView } from '@officemesh/protocol/ipc';
import { shortTime } from '../format.ts';
import {
  avatarSrc,
  closeThread,
  loadOlder,
  loadThread,
  nameOf,
  threadKey,
  useApp,
} from '../state.ts';
import { strings } from '../strings.ts';
import { queueFiles } from '../chat/attachments.ts';
import { useFileDrop } from '../chat/useFileDrop.ts';
import { useColumn } from '../chat/column.ts';
import { Composer } from '../chat/Composer.tsx';
import { MessageItem } from '../chat/MessageItem.tsx';
import { usePendingCount } from '../chat/outbox.ts';
import { PendingSends } from '../chat/PendingSends.tsx';
import { MembersPanel } from '../people/MembersPanel.tsx';
import { FilesTable } from '../files/FilesView.tsx';

const useStyles = makeStyles({
  root: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL} 0`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  scroller: { flex: 1, overflowY: 'auto', minHeight: 0, padding: `${tokens.spacingVerticalM} 0` },
  intro: {
    padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalXXL}`,
    color: tokens.colorNeutralForeground3,
  },
  post: {
    margin: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  announcement: { borderTop: `4px solid ${tokens.colorBrandStroke1}` },
  postHead: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM} 0`,
  },
  replies: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    background: tokens.colorNeutralBackground2,
    borderBottomLeftRadius: tokens.borderRadiusLarge,
    borderBottomRightRadius: tokens.borderRadiusLarge,
  },
  composer: { padding: `0 ${tokens.spacingHorizontalS}` },
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

type TabId = 'posts' | 'files' | 'members';

export function Channel({ convId }: { convId: string }) {
  const styles = useStyles();
  const column = useColumn();
  const conv = useApp((s) => s.conversations[convId]);
  const team = useApp((s) => (conv?.teamId ? s.teams[conv.teamId] : undefined));
  const [tab, setTab] = useState<TabId>('posts');
  const name = conv?.title ?? '';
  const writable = conv?.active === true && !conv.archived;
  const drop = useFileDrop((files) => queueFiles(convId, files), writable && tab === 'posts');
  const dragging = drop.dragging;
  const inCall = useCall((st) => st.call !== null);
  return (
    <section className={styles.root} aria-label={name} data-testid="channel" {...drop.bind}>
      <header className={styles.header}>
        <Avatar shape="square" name={team?.name} color="colorful" size={32} />
        <div className={styles.title}>
          <Text size={400} weight="semibold" data-testid="channel-title">
            {name}
          </Text>
          <Text size={200} className={styles.muted}>
            {team?.name}
          </Text>
        </div>
        <Button
          appearance="subtle"
          icon={<VideoPerson20Regular />}
          disabled={!writable || inCall}
          onClick={() => void meetNow(convId, 'video')}
          data-testid="meet-now"
        >
          {strings.meetings.meetNow}
        </Button>
        <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as TabId)} size="small">
          <Tab value="posts" data-testid="tab-posts">
            {strings.teams.tabs.posts}
          </Tab>
          <Tab value="files" data-testid="tab-files">
            {strings.teams.tabs.files}
          </Tab>
          <Tab value="members" data-testid="tab-members">
            {strings.teams.tabs.members}
          </Tab>
        </TabList>
      </header>
      {tab === 'posts' && (
        <>
          <Posts convId={convId} name={name} writable={writable} />
          {!conv?.active ? (
            <MessageBar intent="warning">
              <MessageBarBody>{strings.groups.notMember}</MessageBarBody>
            </MessageBar>
          ) : conv.archived ? (
            <MessageBar intent="info">
              <MessageBarBody>{strings.groups.archived}</MessageBarBody>
            </MessageBar>
          ) : (
            <div className={mergeClasses(styles.composer, column.column)}>
              <Composer convId={convId} placeholder={strings.teams.newPost} announce />
            </div>
          )}
        </>
      )}
      {tab === 'files' && (
        <div className={styles.scroller}>
          <FilesTable convId={convId} />
        </div>
      )}
      {dragging && (
        <div className={styles.drop}>
          <Text size={500} weight="semibold">
            {strings.compose.dropHere}
          </Text>
        </div>
      )}
      {tab === 'members' && (
        <div className={styles.scroller}>
          <MembersPanel
            convId={conv?.private ? convId : (conv?.teamId ?? convId)}
            {...(!conv?.private && conv?.teamId && { teamId: conv.teamId })}
            manage={team?.role === 'owner'}
          />
        </div>
      )}
    </section>
  );
}

const EMPTY: MessageView[] = [];

function Posts({ convId, name, writable }: { convId: string; name: string; writable: boolean }) {
  const styles = useStyles();
  const column = useColumn();
  const roots = useApp((s) => s.messages[convId] ?? EMPTY);
  const focus = useApp((s) => (s.focusMessage?.convId === convId ? s.focusMessage.id : undefined));
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const pending = usePendingCount(convId);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [roots, pending]);

  useEffect(() => {
    if (!focus) return;
    atBottom.current = false;
    scrollRef.current?.querySelector(`[data-post="${focus}"]`)?.scrollIntoView({ block: 'center' });
    const t = window.setTimeout(() => useApp.setState({ focusMessage: undefined }), 2_500);
    return () => window.clearTimeout(t);
  }, [focus, roots]);

  return (
    <div
      ref={scrollRef}
      className={styles.scroller}
      role="log"
      data-testid="post-list"
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (el.scrollTop < 40 && roots.length >= 200) void loadOlder(convId);
      }}
    >
      <div className={column.column}>
        {roots.length === 0 && (
          <Text as="p" className={styles.intro}>
            {strings.teams.noPosts(name)}
          </Text>
        )}
        {roots.map((m) => (
          <Post key={m.id} convId={convId} root={m} writable={writable} focused={focus === m.id} />
        ))}
        <PendingSends convId={convId} post />
      </div>
    </div>
  );
}

function Post({
  convId,
  root,
  writable,
  focused,
}: {
  convId: string;
  root: MessageView;
  writable: boolean;
  focused: boolean;
}) {
  const styles = useStyles();
  const thread = useApp((s) => s.threads[threadKey(convId, root.id)]);
  const authorAvatar = useApp((s) =>
    root.author === s.identity?.userId ? s.identity.avatarHash : s.people[root.author]?.avatarHash,
  );
  const author = useApp((s) =>
    root.author === s.identity?.userId
      ? s.identity.displayName
      : nameOf(s.people[root.author], root.author),
  );
  const ref = { author: root.author, seq: root.seq };
  const open = thread !== undefined;
  const replies = thread?.slice(1) ?? [];
  return (
    <article
      className={mergeClasses(styles.post, root.announcement && styles.announcement)}
      data-testid="post"
      data-post={root.id}
    >
      <div className={styles.postHead}>
        <Avatar size={24} name={author} color="colorful" image={avatarSrc(authorAvatar)} />
        <Text size={200} weight="semibold">
          {author}
        </Text>
        <Text size={200} className={styles.muted}>
          {shortTime(root.at)}
        </Text>
      </div>
      <MessageItem
        message={root}
        name={author}
        firstOfRun={false}
        focused={focused}
        variant="post"
      />
      <div className={styles.replies}>
        {root.replyCount > 0 && (
          <Button
            appearance="transparent"
            size="small"
            icon={open ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
            onClick={() => (open ? closeThread(convId, root.id) : void loadThread(convId, ref))}
            data-testid="post-replies"
          >
            {open ? strings.teams.hideReplies : strings.teams.replies(root.replyCount)}
          </Button>
        )}
        {open &&
          replies.map((r, i) => (
            <MessageItem
              key={r.id}
              message={r}
              firstOfRun={i === 0 || replies[i - 1]!.author !== r.author}
              focused={false}
              variant="post"
            />
          ))}
        {open && <PendingSends convId={convId} thread={ref} post />}
        {writable &&
          (open ? (
            <div data-testid="thread-composer">
              <Composer convId={convId} thread={ref} placeholder={strings.teams.replyPlaceholder} />
            </div>
          ) : (
            root.replyCount === 0 && (
              <Button
                appearance="transparent"
                size="small"
                onClick={() => void loadThread(convId, ref)}
                data-testid="post-reply"
              >
                {strings.teams.reply}
              </Button>
            )
          ))}
      </div>
    </article>
  );
}

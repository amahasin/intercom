import { memo, useState } from 'react';
import {
  Avatar,
  Button,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  mergeClasses,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  ArrowForward16Regular,
  ArrowReply16Regular,
  Bookmark16Regular,
  BookmarkOffRegular,
  Copy16Regular,
  Delete16Regular,
  Edit16Regular,
  Important16Filled,
  Info16Regular,
  MoreHorizontal16Regular,
  Pin16Filled,
  Pin16Regular,
  PinOff16Regular,
} from '@fluentui/react-icons';
import type { MessageView } from '@officemesh/protocol/ipc';
import { messageTime, shortTime } from '../format.ts';
import { act, avatarSrc, core, displayName, nameOf, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { QUICK_REACTIONS } from './emoji.ts';
import { FileCard } from './FileCard.tsx';
import { ForwardDialog } from './ForwardDialog.tsx';
import { Markdown } from './Markdown.tsx';
import { MessageDetailsDialog } from './MessageDetails.tsx';
import { CallCard, MeetingCard } from './MeetingCards.tsx';
import { PollCard } from './Poll.tsx';

const useStyles = makeStyles({
  row: {
    position: 'relative',
    display: 'flex',
    padding: '2px 0',
  },
  mineRow: { justifyContent: 'flex-end' },
  // The column that holds the sender's picture (empty for the rest of a run of messages).
  pictureColumn: { position: 'absolute', left: '-40px', top: '10px', width: '32px' },
  // The bubble and, under it (outside it), its reactions.
  stack: { display: 'flex', flexDirection: 'column', maxWidth: '90%', minWidth: 0 },
  mineStack: { alignItems: 'flex-end' },
  postStack: { maxWidth: '100%', flex: 1 },
  bubble: {
    position: 'relative',
    maxWidth: '100%',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground3,
    userSelect: 'text',
    // The reaction bar belongs to the bubble: it shows while the pointer is over the bubble (or
    // the keyboard is in it), not over the empty part of the row beside it.
    ':hover .om-actions': { opacity: 1, pointerEvents: 'auto' },
    ':focus-within .om-actions': { opacity: 1, pointerEvents: 'auto' },
  },
  mineBubble: { background: tokens.colorBrandBackground2 },
  /** Channel posts and thread replies: full width, left-aligned, no bubble. */
  postRow: { padding: `2px ${tokens.spacingHorizontalM}` },
  postBubble: {
    maxWidth: '100%',
    flex: 1,
    background: 'transparent',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  /** Who wrote it and when, over the bubble (outside it), small and grey like Teams. */
  headName: { overflow: 'hidden', textOverflow: 'ellipsis' },
  head: {
    display: 'flex',
    alignItems: 'baseline',
    columnGap: tokens.spacingHorizontalS,
    marginBottom: '2px',
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  },
  headMine: { justifyContent: 'flex-end' },
  urgentBubble: { boxShadow: `inset 3px 0 0 ${tokens.colorPaletteRedBorder2}` },
  focused: { outline: `2px solid ${tokens.colorBrandStroke1}` },
  mentionedMe: { boxShadow: `inset 3px 0 0 ${tokens.colorBrandStroke1}` },
  meta: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    alignItems: 'center',
    color: tokens.colorNeutralForeground3,
    marginBottom: '2px',
  },
  urgent: {
    color: tokens.colorPaletteRedForeground1,
    display: 'flex',
    alignItems: 'center',
    columnGap: '2px',
  },
  deleted: { fontStyle: 'italic', color: tokens.colorNeutralForeground3 },
  quote: {
    borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
    padding: `2px ${tokens.spacingHorizontalS}`,
    marginBottom: tokens.spacingVerticalXS,
    background: tokens.colorNeutralBackground1Hover,
    borderRadius: tokens.borderRadiusSmall,
    color: tokens.colorNeutralForeground2,
  },
  preview: {
    marginTop: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    background: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusSmall,
  },
  reactions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    marginTop: '2px',
    paddingInline: tokens.spacingHorizontalS,
  },
  tip: { display: 'flex', flexDirection: 'column', rowGap: '2px' },
  tipHead: { textTransform: 'uppercase', color: tokens.colorNeutralForeground3 },
  reaction: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground1,
    // A native button's text is black until told otherwise: unreadable on a dark background.
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    padding: '1px 8px',
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    boxShadow: tokens.shadow2,
  },
  reactionMine: {
    ...{
      borderTopColor: tokens.colorBrandStroke1,
      borderRightColor: tokens.colorBrandStroke1,
      borderBottomColor: tokens.colorBrandStroke1,
      borderLeftColor: tokens.colorBrandStroke1,
    },
    background: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
  },
  actions: {
    position: 'absolute',
    top: '-18px',
    display: 'flex',
    columnGap: '2px',
    padding: '2px',
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow8,
    opacity: 0,
    pointerEvents: 'none',
    zIndex: 2,
    ':focus-within': { opacity: 1, pointerEvents: 'auto' },
  },
  actionsOpen: { opacity: 1, pointerEvents: 'auto' },
  quick: {
    border: 'none',
    background: 'transparent',
    fontSize: '16px',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
});

export const MessageItem = memo(function MessageItem({
  message: m,
  name,
  firstOfRun,
  focused,
  variant = 'chat',
}: {
  message: MessageView;
  /** The other person in a direct chat; elsewhere each message shows its author. */
  name?: string | undefined;
  firstOfRun: boolean;
  focused: boolean;
  variant?: 'chat' | 'post';
}) {
  const post = variant === 'post';
  // What a message was sent with (urgent, quoting, forwarded, pinned) goes when the message does.
  const showUrgent = m.urgent && !m.deleted;
  const author = useApp(
    (st) =>
      name ??
      (m.author === st.identity?.userId
        ? st.identity.displayName
        : nameOf(st.people[m.author], m.author)),
  );
  const s = useStyles();
  const [forwarding, setForwarding] = useState(false);
  const [detailing, setDetailing] = useState(false);
  // The bar stays while its more-menu is open (the menu is outside the bubble).
  const [menuOpen, setMenuOpen] = useState(false);
  const selfId = useApp((st) => st.identity?.userId);
  const authorAvatar = useApp((st) =>
    m.author === st.identity?.userId ? st.identity.avatarHash : st.people[m.author]?.avatarHash,
  );
  const target = { author: m.author, seq: m.seq };
  // A file you sent to someone who is not here: it goes the moment they are.
  const queuedText =
    m.mine && name
      ? m.status === 'waiting'
        ? strings.chat.status.waiting(name)
        : m.status === 'carried'
          ? strings.chat.status.carried(name)
          : undefined
      : undefined;
  const convId = m.convId;
  const react = (emoji: string, on: boolean) =>
    void act(convId, () => core.invoke('messages.react', { convId, target, emoji, on }));

  return (
    <div
      className={mergeClasses(s.row, post ? s.postRow : m.mine && s.mineRow)}
      style={{ paddingTop: firstOfRun ? 10 : 2 }}
    >
      {!post && !m.mine && (
        <div className={s.pictureColumn} aria-hidden="true">
          {firstOfRun && (
            <Avatar
              name={author}
              size={32}
              color="colorful"
              image={avatarSrc(authorAvatar)}
              data-testid="message-avatar"
            />
          )}
        </div>
      )}
      <div className={mergeClasses(s.stack, post ? s.postStack : m.mine && s.mineStack)}>
        {!post && firstOfRun && (
          <div className={mergeClasses(s.head, m.mine && s.headMine)} data-testid="message-head">
            {!m.mine && (
              <Text size={200} className={s.headName}>
                {author}
              </Text>
            )}
            <Text size={200} title={new Date(m.at).toLocaleString()} data-testid="message-time">
              {messageTime(m.at)}
            </Text>
            {m.edited && !m.deleted && (
              <Text size={200} data-testid="edited">
                {strings.message.edited}
              </Text>
            )}
          </div>
        )}
        <div
          className={mergeClasses(
            s.bubble,
            post ? s.postBubble : m.mine && s.mineBubble,
            showUrgent && s.urgentBubble,
            m.mentionsMe && !m.deleted && !m.urgent && s.mentionedMe,
            focused && s.focused,
          )}
          data-testid="message"
          data-id={m.id}
          data-mine={m.mine}
          data-status={m.status}
        >
          {!m.deleted && (
            <div
              className={mergeClasses('om-actions', s.actions, menuOpen && s.actionsOpen)}
              style={m.mine || post ? { right: 8 } : { left: 8 }}
              role="toolbar"
              aria-label={strings.message.actions}
            >
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={s.quick}
                  aria-label={strings.message.react(e)}
                  onClick={() => react(e, true)}
                  data-testid={`react-${e}`}
                >
                  {e}
                </button>
              ))}
              <Tooltip content={strings.message.reply} relationship="label">
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<ArrowReply16Regular />}
                  aria-label={strings.message.reply}
                  data-testid="action-reply"
                  onClick={() =>
                    useApp.setState((st) => ({ replyTo: { ...st.replyTo, [convId]: m } }))
                  }
                />
              </Tooltip>
              <Menu onOpenChange={(_e, d) => setMenuOpen(d.open)}>
                <MenuTrigger disableButtonEnhancement>
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<MoreHorizontal16Regular />}
                    aria-label={strings.message.more}
                    data-testid="action-more"
                  />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {m.mine && m.kindDetail === 'post' && (
                      <MenuItem
                        icon={<Edit16Regular />}
                        data-testid="action-edit"
                        onClick={() => useApp.setState({ editing: { convId, message: m } })}
                      >
                        {strings.message.edit}
                      </MenuItem>
                    )}
                    {m.mine && (
                      <MenuItem
                        icon={<Delete16Regular />}
                        data-testid="action-delete"
                        onClick={() =>
                          void act(convId, () => core.invoke('messages.delete', { convId, target }))
                        }
                      >
                        {strings.message.delete}
                      </MenuItem>
                    )}
                    <MenuItem
                      icon={<ArrowForward16Regular />}
                      data-testid="action-forward"
                      onClick={() => setForwarding(true)}
                    >
                      {strings.message.forward}
                    </MenuItem>
                    <MenuItem
                      icon={m.pinned ? <PinOff16Regular /> : <Pin16Regular />}
                      data-testid="action-pin"
                      onClick={() =>
                        void act(convId, () =>
                          core.invoke('messages.pin', { convId, target, on: !m.pinned }),
                        )
                      }
                    >
                      {m.pinned ? strings.message.unpin : strings.message.pin}
                    </MenuItem>
                    <MenuItem
                      icon={m.saved ? <BookmarkOffRegular /> : <Bookmark16Regular />}
                      data-testid="action-save"
                      onClick={() =>
                        void act(convId, () =>
                          core.invoke('messages.save', { convId, target, on: !m.saved }),
                        )
                      }
                    >
                      {m.saved ? strings.message.unsave : strings.message.save}
                    </MenuItem>
                    <MenuItem
                      icon={<Copy16Regular />}
                      onClick={() => void navigator.clipboard?.writeText(m.text).catch(() => {})}
                    >
                      {strings.message.copy}
                    </MenuItem>
                    <MenuItem
                      icon={<Info16Regular />}
                      data-testid="action-details"
                      onClick={() => setDetailing(true)}
                    >
                      {strings.message.details}
                    </MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            </div>
          )}

          {((post && firstOfRun) || showUrgent || (m.pinned && !m.deleted)) && (
            <div className={s.meta}>
              {post && firstOfRun && (
                <Text size={200}>
                  {m.mine ? strings.chat.you : author} · {shortTime(m.at)}
                </Text>
              )}
              {showUrgent && (
                <Text size={200} weight="bold" className={s.urgent}>
                  <Important16Filled /> {strings.message.urgent}
                </Text>
              )}
              {m.pinned && !m.deleted && (
                <Text size={200} title={strings.message.pinned}>
                  <Pin16Filled aria-label={strings.message.pinned} />
                </Text>
              )}
            </div>
          )}
          {m.forwarded && !m.deleted && (
            <Text size={200} block className={s.meta}>
              {strings.message.forwardedFrom(m.forwarded.from)}
            </Text>
          )}
          {m.replyTo && !m.deleted && (
            <div className={s.quote} data-testid="reply-quote">
              <Text size={200} weight="semibold" block>
                {displayName(m.replyTo.author)}
              </Text>
              <Text size={200}>
                {m.replyTo.missing ? strings.message.replyMissing : m.replyTo.excerpt}
              </Text>
            </div>
          )}
          {m.deleted ? (
            <Text className={s.deleted}>{strings.message.deleted}</Text>
          ) : (
            <>
              {m.announcement && (
                <Text as="h3" size={500} weight="bold" block data-testid="announcement-headline">
                  {m.announcement.headline}
                </Text>
              )}
              {m.meeting ? (
                <MeetingCard message={m} />
              ) : m.callCard ? (
                <CallCard message={m} />
              ) : m.poll ? (
                <PollCard message={m} />
              ) : (
                m.text && <Markdown text={m.text} />
              )}
              {m.file && (
                <FileCard
                  file={m.file}
                  mine={m.mine}
                  onShare={() => setForwarding(true)}
                  queued={queuedText}
                />
              )}
              {m.preview && (
                <a
                  href={m.preview.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <div className={s.preview} data-testid="link-preview">
                    <Text weight="semibold" size={200} block>
                      {m.preview.title}
                    </Text>
                    {m.preview.description && (
                      <Text size={200} block>
                        {m.preview.description}
                      </Text>
                    )}
                  </div>
                </a>
              )}
            </>
          )}
          {m.edited && !m.deleted && (post || !firstOfRun) && (
            <Text size={100} className={s.meta} data-testid="edited">
              {strings.message.edited}
            </Text>
          )}
        </div>
        {m.reactions.length > 0 && (
          <div className={s.reactions}>
            {m.reactions.map((r) => (
              <Tooltip
                key={r.emoji}
                content={
                  <div className={s.tip}>
                    <Text size={100} weight="semibold" className={s.tipHead}>
                      {strings.message.reactionCount(r.users.length)}
                    </Text>
                    {r.users.map((u) => (
                      <Text key={u} size={200}>
                        {u === selfId
                          ? `${displayName(u)} ${strings.calls.youParen}`
                          : displayName(u)}
                      </Text>
                    ))}
                  </div>
                }
                relationship="description"
              >
                <button
                  type="button"
                  className={mergeClasses(s.reaction, r.mine && s.reactionMine)}
                  aria-pressed={r.mine}
                  onClick={() => react(r.emoji, !r.mine)}
                  data-testid={`reaction-${r.emoji}`}
                >
                  {r.emoji} {r.users.length}
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
      {forwarding && <ForwardDialog message={m} onClose={() => setForwarding(false)} />}
      {detailing && <MessageDetailsDialog message={m} onClose={() => setDetailing(false)} />}
    </div>
  );
});

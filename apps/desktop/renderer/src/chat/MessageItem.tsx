import { memo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
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
  MoreHorizontal16Regular,
  Pin16Filled,
  Pin16Regular,
  PinOff16Regular,
} from '@fluentui/react-icons';
import type { MessageView } from '@officemesh/protocol/ipc';
import { shortTime } from '../format.ts';
import { act, core, displayName, nameOf, openChatWith, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { QUICK_REACTIONS } from './emoji.ts';
import { FileCard } from './FileCard.tsx';
import { Markdown } from './Markdown.tsx';

const useStyles = makeStyles({
  row: {
    position: 'relative',
    display: 'flex',
    padding: `2px ${tokens.spacingHorizontalXXL}`,
    ':hover .om-actions': { opacity: 1 },
  },
  mineRow: { justifyContent: 'flex-end' },
  bubble: {
    position: 'relative',
    maxWidth: '68%',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground3,
    userSelect: 'text',
  },
  mineBubble: { background: tokens.colorBrandBackground2 },
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
  reactions: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: tokens.spacingVerticalXS },
  reaction: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground1,
    padding: '0 6px',
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
  },
  reactionMine: {
    ...{
      borderTopColor: tokens.colorBrandStroke1,
      borderRightColor: tokens.colorBrandStroke1,
      borderBottomColor: tokens.colorBrandStroke1,
      borderLeftColor: tokens.colorBrandStroke1,
    },
    background: tokens.colorBrandBackground2,
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
    zIndex: 2,
    ':focus-within': { opacity: 1 },
  },
  quick: {
    border: 'none',
    background: 'transparent',
    fontSize: '16px',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
});

function ForwardDialog({ message, onClose }: { message: MessageView; onClose: () => void }) {
  const people = useApp((s) => s.people);
  const selfId = useApp((s) => s.identity?.userId);
  const list = Object.values(people).filter((p) => p.userId !== selfId && p.displayName);
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.message.forwardTo}</DialogTitle>
          <DialogContent
            style={{
              display: 'flex',
              flexDirection: 'column',
              rowGap: 4,
              maxHeight: 320,
              overflowY: 'auto',
            }}
          >
            {list.map((p) => (
              <Button
                key={p.userId}
                appearance="subtle"
                style={{ justifyContent: 'flex-start' }}
                data-testid={`forward-to-${p.userId}`}
                onClick={async () => {
                  const conv = await core.invoke('conversations.openDirect', { userId: p.userId });
                  await core.invoke('messages.forward', {
                    convId: message.convId,
                    target: message,
                    toConvId: conv.convId,
                  });
                  onClose();
                  await openChatWith(p.userId);
                }}
              >
                {nameOf(p, p.userId)}
              </Button>
            ))}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export const MessageItem = memo(function MessageItem({
  message: m,
  name,
  firstOfRun,
  focused,
}: {
  message: MessageView;
  name: string;
  firstOfRun: boolean;
  focused: boolean;
}) {
  const s = useStyles();
  const [forwarding, setForwarding] = useState(false);
  const target = { author: m.author, seq: m.seq };
  const convId = m.convId;
  const react = (emoji: string, on: boolean) =>
    void act(convId, () => core.invoke('messages.react', { convId, target, emoji, on }));

  return (
    <div
      className={mergeClasses(s.row, m.mine && s.mineRow)}
      style={{ paddingTop: firstOfRun ? 10 : 2 }}
    >
      <div
        className={mergeClasses(
          s.bubble,
          m.mine && s.mineBubble,
          m.urgent && s.urgentBubble,
          m.mentionsMe && !m.urgent && s.mentionedMe,
          focused && s.focused,
        )}
        data-testid="message"
        data-id={m.id}
        data-mine={m.mine}
        data-status={m.status}
      >
        {!m.deleted && (
          <div
            className={mergeClasses('om-actions', s.actions)}
            style={m.mine ? { right: 8 } : { left: 8 }}
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
            <Menu>
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
                  {m.mine && m.kind === 'text' && (
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
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        )}

        {(firstOfRun || m.urgent || m.pinned) && (
          <div className={s.meta}>
            {firstOfRun && (
              <Text size={200}>
                {m.mine ? strings.chat.you : name} · {shortTime(m.at)}
              </Text>
            )}
            {m.urgent && (
              <Text size={200} weight="bold" className={s.urgent}>
                <Important16Filled /> {strings.message.urgent}
              </Text>
            )}
            {m.pinned && (
              <Text size={200} title={strings.message.pinned}>
                <Pin16Filled aria-label={strings.message.pinned} />
              </Text>
            )}
          </div>
        )}
        {m.forwarded && (
          <Text size={200} block className={s.meta}>
            {strings.message.forwardedFrom(m.forwarded.from)}
          </Text>
        )}
        {m.replyTo && (
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
            {m.text && <Markdown text={m.text} />}
            {m.file && <FileCard file={m.file} />}
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
        {m.edited && !m.deleted && (
          <Text size={100} className={s.meta} data-testid="edited">
            {strings.message.edited}
          </Text>
        )}
        {m.reactions.length > 0 && (
          <div className={s.reactions}>
            {m.reactions.map((r) => (
              <Tooltip
                key={r.emoji}
                content={r.users.map(displayName).join(', ')}
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
    </div>
  );
});

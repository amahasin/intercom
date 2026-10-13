import { useMemo, useState } from 'react';
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  makeStyles,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { ArrowForward20Regular, Document20Regular, Search20Regular } from '@fluentui/react-icons';
import type { MessageView } from '@officemesh/protocol/ipc';
import { presenceBadge, presenceText } from '../format.ts';
import { useListedPeople } from '../people/listed.ts';
import {
  avatarSrc,
  core,
  displayName,
  nameOf,
  openChatWith,
  selectConversation,
  useApp,
} from '../state.ts';
import { strings } from '../strings.ts';
import { GroupAvatar } from './GroupAvatar.tsx';

const useStyles = makeStyles({
  surface: { width: '520px', maxWidth: 'calc(100vw - 32px)' },
  content: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  preview: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    minWidth: 0,
  },
  previewText: { minWidth: 0, display: 'flex', flexDirection: 'column' },
  clip: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflowWrap: 'anywhere',
  },
  muted: { color: tokens.colorNeutralForeground3 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    height: '260px',
    overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXS,
  },
  heading: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXXS}`,
    color: tokens.colorNeutralForeground3,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  rowOn: { background: tokens.colorSubtleBackgroundSelected },
  rowText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { padding: tokens.spacingHorizontalL, textAlign: 'center' },
});

interface Destination {
  key: string;
  /** The conversation, when there is one already. */
  convId?: string;
  /** The person, for a chat to start. */
  userId?: string;
  title: string;
  subtitle: string;
  avatar: React.ReactNode;
  testId: string;
}

/** What the forwarded message looks like in the little preview at the top. */
function previewOf(m: MessageView): { icon: boolean; text: string } {
  if (m.file) return { icon: true, text: m.file.name };
  const text = m.text.trim();
  return { icon: false, text: text || strings.message.forwardNoText };
}

/**
 * Forward a message to one or more chats and people: a preview of it, a search box, the chats and
 * people to pick (several at once), and an optional note that goes after it.
 */
export function ForwardDialog({ message, onClose }: { message: MessageView; onClose: () => void }) {
  const s = useStyles();
  const conversations = useApp((st) => st.conversations);
  const selfId = useApp((st) => st.identity?.userId);
  const people = useListedPeople();
  const [find, setFind] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { chats, others } = useMemo(() => {
    const chatList: Destination[] = Object.values(conversations)
      .filter((c) => c.kind !== 'channel' && !c.temporary && c.active)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((c) => {
        const person = c.peerUserId ? useApp.getState().people[c.peerUserId] : undefined;
        const group = c.kind === 'group';
        return {
          key: `c-${c.convId}`,
          convId: c.convId,
          ...(c.peerUserId && { userId: c.peerUserId }),
          title: group ? c.title : nameOf(person, c.peerUserId ?? c.convId),
          subtitle: group
            ? strings.groups.members(c.memberCount)
            : person
              ? presenceText(person)
              : '',
          avatar: group ? (
            <GroupAvatar title={c.title} picture={c.picture} size={32} />
          ) : (
            <Avatar
              size={32}
              name={nameOf(person, c.peerUserId ?? c.convId)}
              color="colorful"
              image={avatarSrc(person?.avatarHash)}
              badge={person ? presenceBadge(person.presence) : undefined}
            />
          ),
          testId: `forward-to-${group ? c.convId : (c.peerUserId ?? c.convId)}`,
        };
      });
    const chatted = new Set(chatList.map((d) => d.userId).filter(Boolean));
    const rest: Destination[] = people
      .filter((p) => p.displayName && p.userId !== selfId && !chatted.has(p.userId))
      .sort(
        (a, b) =>
          Number(b.online) - Number(a.online) || a.displayName!.localeCompare(b.displayName!),
      )
      .map((p) => ({
        key: `p-${p.userId}`,
        userId: p.userId,
        title: nameOf(p, p.userId),
        subtitle: presenceText(p),
        avatar: (
          <Avatar
            size={32}
            name={nameOf(p, p.userId)}
            color="colorful"
            image={avatarSrc(p.avatarHash)}
            badge={presenceBadge(p.presence)}
          />
        ),
        testId: `forward-to-${p.userId}`,
      }));
    return { chats: chatList, others: rest };
  }, [conversations, people, selfId]);

  const needle = find.trim().toLowerCase();
  const match = (d: Destination) => !needle || d.title.toLowerCase().includes(needle);
  const shownChats = chats.filter(match);
  const shownOthers = others.filter(match);
  const toggle = (key: string) =>
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      let last: string | undefined;
      for (const d of [...chats, ...others].filter((x) => picked.includes(x.key))) {
        const convId =
          d.convId ?? (await core.invoke('conversations.openDirect', { userId: d.userId! })).convId;
        await core.invoke('messages.forward', {
          convId: message.convId,
          target: message,
          toConvId: convId,
        });
        if (note.trim()) await core.invoke('messages.send', { convId, text: note.trim() });
        last = convId;
      }
      onClose();
      // One place to forward to: go there to see it arrive.
      const only =
        picked.length === 1 ? [...chats, ...others].find((x) => x.key === picked[0]) : undefined;
      if (only?.userId && !only.convId) await openChatWith(only.userId);
      else if (only && last) await selectConversation(last);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*?: /, '') : String(err));
      setBusy(false);
    }
  };

  const row = (d: Destination) => {
    const on = picked.includes(d.key);
    return (
      <div
        key={d.key}
        className={`${s.row} ${on ? s.rowOn : ''}`}
        role="option"
        aria-selected={on}
        onClick={() => toggle(d.key)}
        data-testid={d.testId}
        data-selected={on}
      >
        <Checkbox checked={on} tabIndex={-1} aria-label={d.title} />
        {d.avatar}
        <span className={s.rowText}>
          <Text className={s.ellipsis}>{d.title}</Text>
          {d.subtitle && (
            <Text size={200} className={`${s.ellipsis} ${s.muted}`}>
              {d.subtitle}
            </Text>
          )}
        </span>
      </div>
    );
  };

  const preview = previewOf(message);
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && !busy && onClose()}>
      <DialogSurface className={s.surface} data-testid="forward-dialog">
        <DialogBody>
          <DialogTitle>{strings.message.forwardTitle}</DialogTitle>
          <DialogContent className={s.content}>
            <div className={s.preview} data-testid="forward-preview">
              {preview.icon && <Document20Regular />}
              <span className={s.previewText}>
                <Text size={200} weight="semibold">
                  {displayName(message.author)}
                </Text>
                <Text size={200} className={`${s.clip} ${s.muted}`}>
                  {preview.text}
                </Text>
              </span>
            </div>
            <Input
              contentBefore={<Search20Regular />}
              placeholder={strings.message.forwardSearch}
              value={find}
              onChange={(_e, d) => setFind(d.value)}
              data-testid="forward-search"
              autoFocus
            />
            <div
              className={s.list}
              role="listbox"
              aria-multiselectable="true"
              data-testid="forward-list"
            >
              {shownChats.length > 0 && (
                <Text size={200} weight="semibold" className={s.heading}>
                  {strings.message.forwardChats}
                </Text>
              )}
              {shownChats.map(row)}
              {shownOthers.length > 0 && (
                <Text size={200} weight="semibold" className={s.heading}>
                  {strings.message.forwardPeople}
                </Text>
              )}
              {shownOthers.map(row)}
              {shownChats.length + shownOthers.length === 0 && (
                <Text size={200} className={`${s.empty} ${s.muted}`}>
                  {strings.chat.noMatch}
                </Text>
              )}
            </div>
            <Textarea
              resize="none"
              rows={2}
              maxLength={500}
              placeholder={strings.message.forwardNote}
              value={note}
              onChange={(_e, d) => setNote(d.value)}
              data-testid="forward-note"
            />
            {error && (
              <Text
                size={200}
                role="alert"
                data-testid="forward-error"
                style={{ color: tokens.colorPaletteRedForeground1 }}
              >
                {error}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} disabled={busy} data-testid="forward-cancel">
              {strings.me.cancel}
            </Button>
            <Button
              appearance="primary"
              icon={<ArrowForward20Regular />}
              disabled={picked.length === 0 || busy}
              onClick={() => void send()}
              data-testid="forward-send"
            >
              {picked.length > 1
                ? strings.message.forwardCount(picked.length)
                : strings.message.forward}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

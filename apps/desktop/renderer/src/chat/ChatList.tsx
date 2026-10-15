import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Avatar,
  Button,
  CounterBadge,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  makeStyles,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  mergeClasses,
  Text,
  tokens,
  type PositioningVirtualElement,
} from '@fluentui/react-components';
import {
  AlertOff20Regular,
  Alert20Regular,
  Delete20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  EyeOff20Regular,
  MailRead20Regular,
  MailUnread20Regular,
  MoreHorizontal20Regular,
  PeopleAdd20Regular,
  Search20Regular,
  Star20Filled,
  Star20Regular,
} from '@fluentui/react-icons';
import type { ConversationView, PersonView } from '@officemesh/protocol/ipc';
import { presenceBadge, presenceText, shortTime } from '../format.ts';
import {
  avatarSrc,
  core,
  displayName,
  nameOf,
  openChatWith,
  selectConversation,
  useApp,
} from '../state.ts';
import { NewGroupDialog } from './GroupDialogs.tsx';
import {
  hideChat,
  setChatFilter,
  setMarkedUnread,
  toggleFavorite,
  toggleFolded,
  useChatPrefs,
  type ChatFilter,
} from './chatPrefs.ts';
import { strings } from '../strings.ts';
import { isListed } from '../people/listed.ts';
import { GroupAvatar } from './GroupAvatar.tsx';

type Section = 'favorites' | 'chats' | 'people';
type Row =
  | { kind: 'header'; key: string; label: string; section: Section; detail?: string }
  | { kind: 'conv'; key: string; conv: ConversationView; person: PersonView | undefined }
  | { kind: 'person'; key: string; person: PersonView }
  | { kind: 'note'; key: string; text: string };

const ROW_HEIGHT = { header: 36, conv: 60, person: 48, note: 64 } as const;
const FILTERS = ['unread', 'chats', 'groups'] as const satisfies readonly ChatFilter[];

const useStyles = makeStyles({
  root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  find: { flex: 1 },
  findRow: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalXS,
    margin: `0 ${tokens.spacingHorizontalM} ${tokens.spacingVerticalS}`,
  },
  chips: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    margin: `0 ${tokens.spacingHorizontalM} ${tokens.spacingVerticalS}`,
  },
  chip: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusCircular,
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    padding: '2px 12px',
    fontSize: tokens.fontSizeBase200,
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  chipOn: {
    background: tokens.colorBrandBackground,
    borderTopColor: tokens.colorBrandBackground,
    borderRightColor: tokens.colorBrandBackground,
    borderBottomColor: tokens.colorBrandBackground,
    borderLeftColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    ':hover': { background: tokens.colorBrandBackgroundHover },
  },
  scroller: { flex: 1, overflowY: 'auto', minHeight: 0 },
  header: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    width: 'calc(100% - 16px)',
    margin: '0 8px',
    padding: `0 ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXS}`,
    border: 'none',
    background: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    textAlign: 'left',
  },
  headerLabel: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS },
  rowWrap: {
    position: 'relative',
    ':hover .om-row-more': { opacity: 1 },
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
  more: {
    position: 'absolute',
    right: '14px',
    bottom: '6px',
    opacity: 0,
    ':focus-visible': { opacity: 1 },
  },
  selected: { background: tokens.colorSubtleBackgroundSelected },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  line: { display: 'flex', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalS },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: tokens.colorBrandBackground,
    flex: 'none',
  },
  note: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    color: tokens.colorNeutralForeground3,
  },
});

function sortPeople(a: PersonView, b: PersonView): number {
  if (a.online !== b.online) return a.online ? -1 : 1;
  return nameOf(a, a.userId).localeCompare(nameOf(b, b.userId));
}

/** Where the row menu opens: under the "..." button, or at the pointer for a right-click. */
type MenuTarget = { conv: ConversationView; target: PositioningVirtualElement | HTMLElement };

/** `chat`: the conversations. `people`: everyone found on the network (the People rail). */
export function ChatList({ view = 'chat' }: { view?: 'chat' | 'people' }) {
  const styles = useStyles();
  const people = useApp((s) => s.people);
  const conversations = useApp((s) => s.conversations);
  const selectedConv = useApp((s) => s.selectedConv);
  const selectedPerson = useApp((s) => s.selectedPerson);
  const selfId = useApp((s) => s.identity?.userId);
  const favorites = useChatPrefs((s) => s.favorites);
  const hidden = useChatPrefs((s) => s.hidden);
  const markedUnread = useChatPrefs((s) => s.markedUnread);
  const folded = useChatPrefs((s) => s.folded);
  const filter = useChatPrefs((s) => s.filter);
  const [find, setFind] = useState('');
  const [newGroup, setNewGroup] = useState(false);
  const [menu, setMenu] = useState<MenuTarget | undefined>();
  const [personMenu, setPersonMenu] = useState<
    { person: PersonView; target: PositioningVirtualElement | HTMLElement } | undefined
  >();
  const [deleting, setDeleting] = useState<ConversationView | undefined>();
  const [deleteError, setDeleteError] = useState<string>();
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
    const needle = find.trim().toLowerCase();
    const matches = (p: PersonView | undefined, id: string) =>
      !needle || nameOf(p, id).toLowerCase().includes(needle);
    const out: Row[] = [];
    const isUnread = (c: ConversationView) =>
      (c.unread > 0 && c.notify !== 'muted') || markedUnread.includes(c.convId);
    const convs = Object.values(conversations)
      .filter(() => view === 'chat')
      .filter((c) => c.kind !== 'channel')
      // The chat of a call is in the call window until the call is over (and for good if unused).
      .filter((c) => !c.temporary)
      // A hidden chat stays away until something new happens in it.
      .filter((c) => hidden[c.convId] === undefined || c.lastActivityAt > hidden[c.convId]!)
      .filter((c) =>
        filter === 'unread'
          ? isUnread(c)
          : filter === 'groups'
            ? c.kind === 'group'
            : filter === 'chats'
              ? c.kind !== 'group'
              : true,
      )
      .filter((c) =>
        c.kind === 'group'
          ? !needle || c.title.toLowerCase().includes(needle)
          : c.peerUserId && c.peerUserId !== selfId && matches(people[c.peerUserId], c.peerUserId),
      )
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const add = (list: ConversationView[]) => {
      for (const conv of list)
        out.push({
          kind: 'conv',
          key: `c-${conv.convId}`,
          conv,
          person: conv.peerUserId ? people[conv.peerUserId] : undefined,
        });
    };
    const starred = convs.filter((c) => favorites.includes(c.convId));
    const others = convs.filter((c) => !favorites.includes(c.convId));
    if (starred.length > 0) {
      out.push({
        kind: 'header',
        key: 'h-favorites',
        label: strings.chat.favorites,
        section: 'favorites',
      });
      if (!folded.favorites) add(starred);
    }
    if (others.length > 0) {
      out.push({ kind: 'header', key: 'h-chats', label: strings.chat.chats, section: 'chats' });
      if (!folded.chats) add(others);
    }
    if (view === 'chat' && filter === 'unread' && convs.length === 0)
      out.push({ kind: 'note', key: 'n-unread', text: strings.chat.noUnread });
    // Everyone on the network has a rail of their own, so the list of chats stays clean.
    if (view === 'people') {
      const chatted = new Set(
        Object.values(conversations)
          .map((c) => c.peerUserId)
          .filter((id): id is string => id !== undefined),
      );
      const now = Date.now();
      const everyone = Object.values(people).filter(
        (p) => p.userId !== selfId && isListed(p, chatted.has(p.userId), now),
      );
      const shown = everyone.filter((p) => matches(p, p.userId)).sort(sortPeople);
      const online = everyone.filter((p) => p.online).length;
      out.push({
        kind: 'header',
        key: 'h-people',
        label: strings.chat.people,
        section: 'people',
        detail: strings.chat.online(online),
      });
      if (!folded.people) {
        if (everyone.length === 0)
          out.push({ kind: 'note', key: 'n-none', text: strings.chat.nobody });
        else if (shown.length === 0)
          out.push({ kind: 'note', key: 'n-match', text: strings.chat.noMatch });
        for (const person of shown) out.push({ kind: 'person', key: `p-${person.userId}`, person });
      }
    }
    if (view === 'chat' && out.length === 0 && !needle)
      out.push({ kind: 'note', key: 'n-nochats', text: strings.chat.noChats });
    return out;
  }, [people, conversations, find, selfId, favorites, hidden, markedUnread, folded, filter, view]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ROW_HEIGHT[rows[i]!.kind],
    getItemKey: (i) => rows[i]!.key,
    overscan: 10,
  });

  const open = (conv: ConversationView) => {
    setMarkedUnread(conv.convId, false);
    void selectConversation(conv.convId);
  };

  return (
    <div className={styles.root}>
      <div className={styles.findRow}>
        <Input
          ref={findRef}
          className={styles.find}
          contentBefore={<Search20Regular />}
          placeholder={`${strings.chat.find} (${strings.chat.findShortcut})`}
          aria-label={strings.chat.find}
          value={find}
          onChange={(_e, d) => setFind(d.value)}
          data-testid="people-filter"
        />
        {view === 'chat' && (
          <Button
            appearance="subtle"
            icon={<PeopleAdd20Regular />}
            aria-label={strings.groups.newGroup}
            title={strings.groups.newGroup}
            onClick={() => setNewGroup(true)}
            data-testid="new-group"
          />
        )}
      </div>
      <div
        className={styles.chips}
        role="group"
        aria-label={strings.chat.filters}
        style={view === 'people' ? { display: 'none' } : undefined}
      >
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={mergeClasses(styles.chip, filter === f && styles.chipOn)}
            aria-pressed={filter === f}
            onClick={() => setChatFilter(filter === f ? 'all' : f)}
            data-testid={`chat-filter-${f}`}
          >
            {strings.chat.filter[f]}
          </button>
        ))}
      </div>
      {newGroup && <NewGroupDialog onClose={() => setNewGroup(false)} />}
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
      <PersonMenu menu={personMenu} onClose={() => setPersonMenu(undefined)} />
      <RowMenu
        menu={menu}
        onClose={() => setMenu(undefined)}
        onDelete={(conv) => {
          setDeleteError(undefined);
          setDeleting(conv);
        }}
      />
      {deleting && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setDeleting(undefined)}>
          <DialogSurface data-testid="delete-chat-dialog">
            <DialogBody>
              <DialogTitle>{strings.chat.deleteDialog.title}</DialogTitle>
              <DialogContent>
                <Text block>
                  {strings.chat.deleteDialog.body(
                    deleting.kind === 'group'
                      ? deleting.title
                      : nameOf(
                          deleting.peerUserId ? people[deleting.peerUserId] : undefined,
                          deleting.peerUserId ?? deleting.convId,
                        ),
                    deleting.kind === 'group',
                  )}
                </Text>
                {deleteError && (
                  <Text block role="alert">
                    {deleteError}
                  </Text>
                )}
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setDeleting(undefined)} data-testid="delete-chat-cancel">
                  {strings.chat.deleteDialog.cancel}
                </Button>
                <Button
                  appearance="primary"
                  data-testid="delete-chat-confirm"
                  onClick={() => {
                    const conv = deleting;
                    core
                      .invoke('conversations.delete', { convId: conv.convId })
                      .then(() => {
                        // Gone from the list until the other side writes again.
                        hideChat(conv.convId, conv.lastActivityAt);
                        if (useApp.getState().selectedConv === conv.convId)
                          useApp.setState({ selectedConv: undefined });
                        setDeleting(undefined);
                      })
                      .catch((err: unknown) =>
                        setDeleteError(err instanceof Error ? err.message : String(err)),
                      );
                  }}
                >
                  {strings.chat.deleteDialog.confirm}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );

  function renderRow(row: Row) {
    switch (row.kind) {
      case 'header': {
        const isFolded = folded[row.section];
        return (
          <button
            type="button"
            className={styles.header}
            style={{ height: '100%' }}
            aria-expanded={!isFolded}
            onClick={() => toggleFolded(row.section)}
            data-testid={`section-${row.section}`}
          >
            <span className={styles.headerLabel}>
              {isFolded ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
              <Text size={200} weight="semibold">
                {row.label}
              </Text>
            </span>
            {row.detail && <Text size={200}>{row.detail}</Text>}
          </button>
        );
      }
      case 'note':
        return (
          <Text as="p" size={200} className={styles.note}>
            {row.text}
          </Text>
        );
      case 'conv': {
        const group = row.conv.kind === 'group';
        const userId = row.conv.peerUserId ?? row.conv.convId;
        const name = group ? row.conv.title : nameOf(row.person, userId);
        const last = row.conv.lastMessage;
        const lastBy = !last
          ? ''
          : last.author === selfId
            ? `${strings.chat.you}: `
            : group
              ? `${displayName(last.author)}: `
              : '';
        const marked = markedUnread.includes(row.conv.convId);
        const unread = (row.conv.unread > 0 && row.conv.notify !== 'muted') || marked;
        return (
          <div
            className={styles.rowWrap}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                conv: row.conv,
                target: {
                  getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0),
                },
              });
            }}
          >
            <button
              type="button"
              className={mergeClasses(
                styles.row,
                selectedConv === row.conv.convId && styles.selected,
              )}
              style={{ height: ROW_HEIGHT.conv - 4 }}
              onClick={() => open(row.conv)}
              aria-current={selectedConv === row.conv.convId ? 'true' : undefined}
              data-testid={`conv-${userId}`}
              data-unread={unread ? 'true' : 'false'}
            >
              {group ? (
                <GroupAvatar title={name} picture={row.conv.picture} size={36} />
              ) : (
                <Avatar
                  name={name}
                  size={36}
                  color="colorful"
                  image={avatarSrc(row.person?.avatarHash)}
                  badge={presenceBadge(row.person?.presence ?? 'offline')}
                />
              )}
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
                <span className={styles.line}>
                  <Text
                    size={200}
                    weight={unread ? 'semibold' : 'regular'}
                    className={mergeClasses(styles.ellipsis, !unread && styles.muted)}
                  >
                    {last ? `${lastBy}${last.text}` : strings.chat.noMessagesYet}
                  </Text>
                  {marked && <span className={styles.dot} data-testid="conv-marked-unread" />}
                </span>
              </span>
            </button>
            <Button
              className={mergeClasses('om-row-more', styles.more)}
              size="small"
              appearance="subtle"
              icon={<MoreHorizontal20Regular />}
              aria-label={strings.chat.rowMenu(name)}
              onClick={(e) => setMenu({ conv: row.conv, target: e.currentTarget })}
              data-testid={`conv-more-${userId}`}
            />
          </div>
        );
      }
      case 'person': {
        const { person } = row;
        const name = nameOf(person, person.userId);
        return (
          <div
            className={styles.rowWrap}
            onContextMenu={(e) => {
              if (person.online) return;
              e.preventDefault();
              setPersonMenu({
                person,
                target: { getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) },
              });
            }}
          >
            <button
              type="button"
              className={mergeClasses(
                styles.row,
                selectedPerson === person.userId && styles.selected,
              )}
              style={{ height: ROW_HEIGHT.person - 4 }}
              onClick={() => useApp.setState({ selectedPerson: person.userId })}
              onDoubleClick={() => void openChatWith(person.userId)}
              aria-current={selectedPerson === person.userId ? 'true' : undefined}
              data-testid={`person-${person.userId}`}
              data-online={person.online}
              aria-label={`${name}, ${presenceText(person)}`}
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
                  {person.statusMessage || person.jobTitle || presenceText(person)}
                </Text>
              </span>
            </button>
            {!person.online && (
              <Button
                className={mergeClasses('om-row-more', styles.more)}
                size="small"
                appearance="subtle"
                icon={<MoreHorizontal20Regular />}
                aria-label={strings.chat.rowMenu(name)}
                onClick={(e) => setPersonMenu({ person, target: e.currentTarget })}
                data-testid={`person-more-${person.userId}`}
              />
            )}
          </div>
        );
      }
    }
  }
}

/** The menu of an offline colleague in the people list: take them (or all offline ones) off it. */
function PersonMenu({
  menu,
  onClose,
}: {
  menu: { person: PersonView; target: PositioningVirtualElement | HTMLElement } | undefined;
  onClose: () => void;
}) {
  const hide = async (userIds: string[]) => {
    const changed = await core.invoke('people.hide', { userIds, hidden: true });
    useApp.setState((s) => ({
      people: { ...s.people, ...Object.fromEntries(changed.map((p) => [p.userId, p])) },
    }));
  };
  return (
    <Menu
      open={menu !== undefined}
      onOpenChange={(_e, d) => !d.open && onClose()}
      positioning={menu ? { target: menu.target, position: 'below', align: 'start' } : undefined}
    >
      <MenuPopover>
        <MenuList>
          {menu && (
            <>
              <MenuItem
                icon={<Delete20Regular />}
                onClick={() => void hide([menu.person.userId])}
                data-testid="person-remove"
              >
                {strings.chat.personMenu.remove}
              </MenuItem>
              <MenuItem
                icon={<EyeOff20Regular />}
                onClick={() =>
                  void hide(
                    Object.values(useApp.getState().people)
                      .filter((p) => !p.online && p.userId !== useApp.getState().identity?.userId)
                      .map((p) => p.userId),
                  )
                }
                data-testid="person-remove-offline"
              >
                {strings.chat.personMenu.removeOffline}
              </MenuItem>
            </>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/** The menu of one chat in the list (the "..." button, or a right-click on the row). */
function RowMenu({
  menu,
  onClose,
  onDelete,
}: {
  menu: MenuTarget | undefined;
  onClose: () => void;
  onDelete: (conv: ConversationView) => void;
}) {
  const favorites = useChatPrefs((s) => s.favorites);
  const markedUnread = useChatPrefs((s) => s.markedUnread);
  const conv = menu?.conv;
  const favorite = conv ? favorites.includes(conv.convId) : false;
  const unread = conv
    ? (conv.unread > 0 && conv.notify !== 'muted') || markedUnread.includes(conv.convId)
    : false;
  const muted = conv?.notify === 'muted';
  return (
    <Menu
      open={menu !== undefined}
      onOpenChange={(_e, d) => !d.open && onClose()}
      positioning={menu ? { target: menu.target, position: 'below', align: 'start' } : undefined}
    >
      <MenuPopover>
        <MenuList>
          {conv && (
            <>
              <MenuItem
                icon={favorite ? <Star20Filled /> : <Star20Regular />}
                onClick={() => toggleFavorite(conv.convId)}
                data-testid="row-favorite"
              >
                {favorite ? strings.chat.menu.unfavorite : strings.chat.menu.favorite}
              </MenuItem>
              <MenuItem
                icon={unread ? <MailRead20Regular /> : <MailUnread20Regular />}
                onClick={() => {
                  if (unread) {
                    setMarkedUnread(conv.convId, false);
                    if (conv.unread > 0)
                      void core.invoke('messages.markRead', { convId: conv.convId });
                  } else setMarkedUnread(conv.convId, true);
                }}
                data-testid="row-unread"
              >
                {unread ? strings.chat.menu.markRead : strings.chat.menu.markUnread}
              </MenuItem>
              <MenuItem
                icon={muted ? <Alert20Regular /> : <AlertOff20Regular />}
                onClick={() =>
                  void core.invoke('notifications.setLevel', {
                    convId: conv.convId,
                    level: muted ? 'all' : 'muted',
                  })
                }
                data-testid="row-mute"
              >
                {muted ? strings.chat.menu.unmute : strings.chat.menu.mute}
              </MenuItem>
              <MenuDivider />
              <MenuItem
                icon={<EyeOff20Regular />}
                onClick={() => hideChat(conv.convId, conv.lastActivityAt)}
                data-testid="row-hide"
              >
                {strings.chat.menu.hide}
              </MenuItem>
              <MenuItem
                icon={<Delete20Regular />}
                onClick={() => onDelete(conv)}
                data-testid="row-delete"
              >
                {strings.chat.menu.delete}
              </MenuItem>
            </>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

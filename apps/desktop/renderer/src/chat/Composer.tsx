import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  Avatar,
  Button,
  makeStyles,
  mergeClasses,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Portal,
  Text,
  ToggleButton,
  Input,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  Attach20Regular,
  Code20Regular,
  CodeBlock20Regular,
  Dismiss16Regular,
  Document24Regular,
  Emoji20Regular,
  Folder24Regular,
  FolderAdd20Regular,
  Important20Regular,
  Poll20Regular,
  Megaphone20Regular,
  ScreenCut20Regular,
  Send20Filled,
  TextBold20Regular,
  TextBulletListLtr20Regular,
  TextItalic20Regular,
  TextNumberListLtr20Regular,
  TextQuote20Regular,
  TextStrikethrough20Regular,
} from '@fluentui/react-icons';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createCodeNode, $isCodeNode, CodeNode } from '@lexical/code';
import { AutoLinkNode, LinkNode } from '@lexical/link';
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown';
import { $createQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text';
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  FORMAT_TEXT_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import type { LinkPreview, MsgRef } from '@officemesh/protocol';
import type { PersonView } from '@officemesh/protocol/ipc';
import { act, avatarSrc, core, nameOf, useApp } from '../state.ts';
import { presenceBadge } from '../format.ts';
import { PresenceDot } from '../shell/PresenceDot.tsx';
import { strings } from '../strings.ts';
import { useListedPeople } from '../people/listed.ts';
import { composerKey, queueFiles, useAttachments } from './attachments.ts';
import { useDrafts } from './drafts.ts';
import { sendFiles } from './outbox.ts';
import { EMOJI_GROUPS } from './emoji.ts';
import { formatSize } from './FileCard.tsx';
import { PollDialog } from './Poll.tsx';
import {
  $createMentionNode,
  $makeBlock,
  EDITOR_THEME,
  MentionNode,
  OM_TRANSFORMERS,
} from './lexical.ts';

const useStyles = makeStyles({
  root: {
    margin: `0 ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalL}`,
    minWidth: 0,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    ':focus-within': { borderBottomColor: tokens.colorCompoundBrandStroke },
  },
  flush: { marginLeft: 0, marginRight: 0 },
  // In a narrow pane (the meeting chat) the buttons wrap onto a second line.
  tools: { flexWrap: 'wrap', rowGap: 0, minWidth: 0, flex: 1 },
  urgent: {
    borderTopColor: tokens.colorPaletteRedBorder2,
    borderRightColor: tokens.colorPaletteRedBorder2,
    borderBottomColor: tokens.colorPaletteRedBorder2,
    borderLeftColor: tokens.colorPaletteRedBorder2,
  },
  banner: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
  },
  grow: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  editorWrap: {
    position: 'relative',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM} 0`,
  },
  editor: {
    minHeight: '22px',
    maxHeight: '220px',
    overflowY: 'auto',
    outline: 'none',
    userSelect: 'text',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
  },
  placeholder: {
    position: 'absolute',
    top: tokens.spacingVerticalS,
    left: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground4,
    pointerEvents: 'none',
  },
  bottom: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  // The menu of people to mention. It is drawn in a portal of its own, inside the Fluent provider
  // (the anchor Lexical makes is on <body>, outside it, where the theme's colors do not exist:
  // the menu used to come out with no background, as plain words over the message box).
  menu: {
    position: 'fixed',
    width: '300px',
    maxHeight: '264px',
    overflowY: 'auto',
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow28,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalXS,
    zIndex: 1000,
  },
  menuHead: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    color: tokens.colorNeutralForeground3,
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
  },
  optionName: { flex: 1, minWidth: 0 },
  optionClip: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'block',
  },
  optionSub: { color: tokens.colorNeutralForeground3 },
  optionActive: {
    background: tokens.colorBrandBackground2,
    boxShadow: `inset 3px 0 0 ${tokens.colorBrandForeground1}`,
  },
  emojiGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(8, 32px)',
    gap: '2px',
    maxHeight: '260px',
    overflowY: 'auto',
  },
  emoji: {
    fontSize: '20px',
    border: 'none',
    background: 'transparent',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  attachments: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM} 0`,
  },
  tile: {
    position: 'relative',
    width: '104px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  tileThumb: {
    width: '100%',
    height: '72px',
    display: 'grid',
    placeItems: 'center',
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
  },
  tileImage: { width: '100%', height: '100%', objectFit: 'cover' },
  tileText: { padding: `2px ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXS}` },
  tileName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'block',
  },
  tileRemove: {
    position: 'absolute',
    top: '2px',
    right: '2px',
    minWidth: '22px',
    width: '22px',
    height: '22px',
    background: 'rgb(0 0 0 / 0.55)',
    color: '#fff',
    ':hover': { background: 'rgb(0 0 0 / 0.75)', color: '#fff' },
  },
  notice: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM} 0`,
    color: tokens.colorPaletteRedForeground1,
  },
  preview: {
    margin: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM} 0`,
    padding: tokens.spacingHorizontalS,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    background: tokens.colorNeutralBackground2,
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
  },
});

class PersonOption extends MenuOption {
  person: PersonView;
  constructor(person: PersonView) {
    super(person.userId);
    this.person = person;
  }
}

/** The people who can be mentioned in a chat: the others in it, else everyone listed. */
function useMentionable(convId: string): PersonView[] {
  const listed = useListedPeople();
  const people = useApp((st) => st.people);
  const selfId = useApp((st) => st.identity?.userId);
  // Whose members these are is remembered with them, so a chat that was left does not lend its list.
  const [loaded, setLoaded] = useState<{ convId: string; ids: string[] }>();
  useEffect(() => {
    let live = true;
    void core
      .invoke('conversations.members', { convId })
      .then((list) => live && setLoaded({ convId, ids: list.map((m) => m.userId) }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [convId]);
  const members = loaded?.convId === convId ? loaded.ids : undefined;
  return useMemo(() => {
    if (!members || members.length === 0) return listed;
    // A member who dropped off the lists (removed, long gone) can still be mentioned in a chat
    // they are in.
    const named = members
      .filter((id) => id !== selfId)
      .map((id) => people[id])
      .filter((p): p is PersonView => p !== undefined);
    return named.length > 0 ? named : listed;
  }, [members, listed, people, selfId]);
}

/**
 * The menu itself: just above the text box (below it when there is no room above), its left edge
 * level with the box's. Placed from the box, not from where Lexical puts its own anchor for the
 * menu: that anchor is not in place yet when the menu first appears.
 */
function MentionMenu({
  options,
  selectedIndex,
  onPick,
  onHover,
}: {
  options: PersonOption[];
  selectedIndex: number | null;
  onPick: (o: PersonOption) => void;
  onHover: (i: number) => void;
}) {
  const styles = useStyles();
  const [editor] = useLexicalComposerContext();
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | undefined>();
  useLayoutEffect(() => {
    const at = editor.getRootElement()?.getBoundingClientRect();
    if (!at) return;
    const height = box.current?.offsetHeight ?? 0;
    const width = box.current?.offsetWidth ?? 300;
    const above = at.top - height - 8;
    setPlace({
      left: Math.max(8, Math.min(at.left, window.innerWidth - width - 8)),
      top: above >= 8 ? above : Math.min(at.bottom + 8, window.innerHeight - height - 8),
    });
  }, [editor, options.length]);
  // Moving through the list with the arrow keys keeps the highlighted one in view.
  useEffect(() => {
    box.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);
  return (
    <Portal>
      <div
        ref={box}
        className={styles.menu}
        role="listbox"
        data-testid="mention-menu"
        style={{
          left: place?.left ?? -9999,
          top: place?.top ?? -9999,
          visibility: place ? 'visible' : 'hidden',
        }}
      >
        {options.map((o, i) => (
          <div
            key={o.key}
            role="option"
            aria-selected={i === selectedIndex}
            data-testid="mention-option"
            className={mergeClasses(styles.option, i === selectedIndex && styles.optionActive)}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(o);
            }}
          >
            <Avatar
              name={nameOf(o.person, o.person.userId)}
              size={28}
              color="colorful"
              image={avatarSrc(o.person.avatarHash)}
              badge={presenceBadge(o.person.presence)}
            />
            <span className={styles.optionName}>
              <Text weight="semibold" className={styles.optionClip}>
                {o.person.displayName}
              </Text>
              {o.person.jobTitle && (
                <Text size={200} className={mergeClasses(styles.optionClip, styles.optionSub)}>
                  {o.person.jobTitle}
                </Text>
              )}
            </span>
            {o.person.online && <PresenceDot state={o.person.presence} />}
          </div>
        ))}
      </div>
    </Portal>
  );
}

function MentionsPlugin({
  convId,
  onMenuOpen,
}: {
  convId: string;
  onMenuOpen: (open: boolean) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const people = useMentionable(convId);
  const triggerFn = useBasicTypeaheadTriggerMatch('@', { minLength: 0 });
  const options = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    // Names that start with what was typed come first, then names with a word that does, then
    // names that contain it; people at their PC before those who are not.
    const rank = (p: PersonView) => {
      const n = p.displayName!.toLowerCase();
      if (q === '' || n.startsWith(q)) return 0;
      return n.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2;
    };
    return people
      .filter((p) => p.displayName && (q === '' || p.displayName.toLowerCase().includes(q)))
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          Number(b.online) - Number(a.online) ||
          a.displayName!.localeCompare(b.displayName!),
      )
      .slice(0, 50)
      .map((p) => new PersonOption(p));
  }, [people, query]);
  const onSelectOption = useCallback(
    (option: PersonOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const mention = $createMentionNode(option.person.userId, `@${option.person.displayName!}`);
        if (nodeToReplace) nodeToReplace.replace(mention);
        const space = $createTextNode(' ');
        mention.insertAfter(space);
        space.select();
        closeMenu();
      });
    },
    [editor],
  );
  return (
    <LexicalTypeaheadMenuPlugin<PersonOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      options={options}
      onOpen={() => onMenuOpen(true)}
      onClose={() => onMenuOpen(false)}
      menuRenderFn={(anchor, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchor.current && options.length > 0 ? (
          <MentionMenu
            options={options}
            selectedIndex={selectedIndex}
            onPick={selectOptionAndCleanUp}
            onHover={setHighlightedIndex}
          />
        ) : null
      }
    />
  );
}

/**
 * Enter sends; Shift+Enter, an open mention menu, a code block or a list keep Enter's usual meaning
 * (in a list: the next bullet or number, and on an empty one the list ends). From inside a list or
 * a code block the message is sent with Ctrl+Enter (or the Send button).
 */
function EnterToSend({ onSend, isMenuOpen }: { onSend: () => void; isMenuOpen: () => boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          if (event?.shiftKey || isMenuOpen()) return false;
          let inCode = false;
          let inList = false;
          editor.getEditorState().read(() => {
            const sel = $getSelection();
            if ($isRangeSelection(sel)) {
              const top = sel.anchor.getNode().getTopLevelElement();
              inCode = $isCodeNode(top);
              inList = $isListNode(top);
            }
          });
          // In a code block or a list Enter is a new line or item; Ctrl+Enter sends.
          if ((inCode || inList) && !(event?.ctrlKey || event?.metaKey)) return false;
          event?.preventDefault();
          onSend();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, onSend, isMenuOpen],
  );
  return null;
}

function EditorReady({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

const URL_RE = /\bhttps?:\/\/[^\s<>()]+/;

const sameRef = (a: MsgRef | undefined, b: MsgRef | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.author === b.author && a.seq === b.seq);

export function Composer({
  convId,
  placeholder,
  thread,
  announce = false,
  flush = false,
}: {
  convId: string;
  placeholder: string;
  /** No margin at the sides: the box is as wide as the column it is in. */
  flush?: boolean;
  /** Reply in this channel thread. */
  thread?: MsgRef | undefined;
  /** Offer the announcement style (channel root posts). */
  announce?: boolean;
}) {
  const styles = useStyles();
  const [polling, setPolling] = useState(false);
  const [headline, setHeadline] = useState<string | null>(null);
  const [editor, setEditor] = useState<LexicalEditor | null>(null);
  const menuOpen = useRef(false);
  const setMenuOpen = useCallback((open: boolean) => {
    menuOpen.current = open;
  }, []);
  const isMenuOpen = useCallback(() => menuOpen.current, []);
  const pickFiles = useCallback(() => fileInput.current?.click(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);
  const [urgent, setUrgent] = useState(false);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const dismissedUrl = useRef<string | null>(null);
  const lastTyping = useRef(0);
  const previewTimer = useRef<number | undefined>(undefined);
  const replyTo = useApp((s) => (thread ? undefined : s.replyTo[convId]));
  const editing = useApp((s) =>
    s.editing?.convId === convId && sameRef(s.editing.message.thread, thread)
      ? s.editing.message
      : undefined,
  );

  const key = composerKey(convId, thread);
  // Something typed (or a poll being made) is held here: the app is not restarted for an update now.
  const setDraft = useDrafts((s) => s.set);
  useEffect(() => {
    setDraft(key, !empty);
    return () => setDraft(key, false);
  }, [key, empty, setDraft]);
  useEffect(() => {
    setDraft(`${key}|poll`, polling);
    return () => setDraft(`${key}|poll`, false);
  }, [key, polling, setDraft]);
  const queuedFiles = useAttachments((s) => s.byKey[key]);
  const queuedCount = queuedFiles?.length ?? 0;
  const attachNotice = useAttachments((s) => s.notice[key]);

  const initialConfig = useMemo(
    () => ({
      namespace: 'officemesh-composer',
      theme: EDITOR_THEME,
      nodes: [
        HeadingNode,
        QuoteNode,
        ListNode,
        ListItemNode,
        CodeNode,
        LinkNode,
        AutoLinkNode,
        MentionNode,
      ],
      onError: (err: Error) => console.error(err),
    }),
    [],
  );

  // Load the message being edited.
  useEffect(() => {
    if (!editor) return;
    editor.update(() => {
      $getRoot().clear();
      if (editing) $convertFromMarkdownString(editing.text, OM_TRANSFORMERS);
    });
    editor.focus();
  }, [editing, editor]);

  useEffect(() => {
    if (replyTo) editor?.focus();
  }, [replyTo, editor]);

  const reset = () => {
    editor?.update(() => $getRoot().clear());
    setUrgent(false);
    setHeadline(null);
    setPreview(null);
    dismissedUrl.current = null;
    useApp.setState((s) => ({
      replyTo: { ...s.replyTo, [convId]: undefined },
      editing: undefined,
    }));
  };

  const send = useCallback(async () => {
    if (!editor) return;
    const text = editor
      .getEditorState()
      .read(() => $convertToMarkdownString(OM_TRANSFORMERS))
      .trim();
    const key = composerKey(convId, thread);
    const queued = useAttachments.getState().byKey[key] ?? [];
    if (!text && queued.length === 0) return;
    const st = useApp.getState();
    const editingNow =
      st.editing?.convId === convId && sameRef(st.editing.message.thread, thread)
        ? st.editing.message
        : undefined;
    const reply = thread ? undefined : st.replyTo[convId];
    const announcement = headline?.trim() ? { headline: headline.trim() } : undefined;
    if (queued.length > 0 && !editingNow) {
      // Files go with the message (the text is the first file's caption). They leave the strip
      // now and appear in the chat, where their progress is shown (see outbox.ts).
      const replyRef = reply ? { author: reply.author, seq: reply.seq } : undefined;
      const files = useAttachments.getState().take(key);
      reset();
      sendFiles(convId, files, { text, urgent, thread, replyTo: replyRef });
      return;
    }
    if (!text) return;
    reset();
    if (editingNow) {
      await act(convId, () => core.invoke('messages.edit', { convId, target: editingNow, text }));
    } else {
      await act(convId, () =>
        core.invoke('messages.send', {
          convId,
          text,
          ...(reply && { replyTo: { author: reply.author, seq: reply.seq } }),
          ...(urgent && { urgent: true }),
          ...(preview && { preview }),
          ...(thread && { thread }),
          ...(announcement && { announcement }),
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, urgent, preview, editor, thread, headline]);

  const onChange = (editorState: { read: <T>(fn: () => T) => T }) => {
    const text = editorState.read(() => $getRoot().getTextContent());
    setEmpty(text.trim() === '');
    const now = Date.now();
    if (text && now - lastTyping.current > 3_000) {
      lastTyping.current = now;
      void core.invoke('typing.notify', { convId });
    }
    const url = URL_RE.exec(text)?.[0];
    window.clearTimeout(previewTimer.current);
    if (!url) {
      setPreview(null);
      return;
    }
    if (url === preview?.url || url === dismissedUrl.current) return;
    previewTimer.current = window.setTimeout(() => {
      void core
        .invoke('links.preview', { url })
        .then((p) => setPreview(p))
        .catch(() => setPreview(null));
    }, 600);
  };

  const format = (f: 'bold' | 'italic' | 'strikethrough' | 'code') =>
    editor?.dispatchCommand(FORMAT_TEXT_COMMAND, f);
  const block = (kind: 'quote' | 'code') =>
    editor?.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel))
        $makeBlock(sel, () => (kind === 'quote' ? $createQuoteNode() : $createCodeNode()));
    });
  const insertEmoji = (e: string) =>
    editor?.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) sel.insertText(e);
    });

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    queueFiles(convId, files, thread);
  };

  const tool = (label: string, icon: JSX.Element, onClick: () => void, testId?: string) => (
    <Tooltip content={label} relationship="label">
      <ToolbarButton
        aria-label={label}
        icon={icon}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        data-testid={testId}
      />
    </Tooltip>
  );

  return (
    <div
      className={mergeClasses(styles.root, flush && styles.flush, urgent && styles.urgent)}
      onPaste={onPaste}
      data-testid="composer-box"
    >
      {(replyTo || editing) && (
        <div className={styles.banner}>
          <Text size={200} weight="semibold">
            {editing ? strings.compose.editing : strings.compose.replyingTo}
          </Text>
          <Text size={200} className={styles.grow}>
            {(editing ?? replyTo)!.text.slice(0, 120)}
          </Text>
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            aria-label={strings.me.cancel}
            onClick={reset}
          />
        </div>
      )}
      {headline !== null && (
        <div className={styles.banner}>
          <Input
            className={styles.grow}
            appearance="underline"
            size="large"
            placeholder={strings.teams.headline}
            aria-label={strings.teams.headline}
            maxLength={200}
            value={headline}
            onChange={(_e, d) => setHeadline(d.value)}
            data-testid="announcement-input"
          />
        </div>
      )}
      {urgent && (
        <div className={styles.banner} style={{ color: tokens.colorPaletteRedForeground1 }}>
          <Important20Regular />
          <Text size={200} weight="semibold">
            {strings.compose.urgentOn}
          </Text>
        </div>
      )}
      {queuedFiles && queuedFiles.length > 0 && !editing && (
        <div className={styles.attachments} data-testid="attachments">
          {queuedFiles.map((a) => {
            return (
              <div key={a.id} className={styles.tile} data-testid="attachment" title={a.name}>
                <div className={styles.tileThumb}>
                  {a.previewUrl ? (
                    <img
                      className={styles.tileImage}
                      src={a.previewUrl}
                      alt={a.name}
                      data-testid="attachment-preview"
                    />
                  ) : a.folder ? (
                    <Folder24Regular />
                  ) : (
                    <Document24Regular />
                  )}
                </div>
                <div className={styles.tileText}>
                  <Text size={200} className={styles.tileName}>
                    {a.name}
                  </Text>
                  <Text size={100} className={styles.grow}>
                    {a.folder ? strings.compose.folder : formatSize(a.size)}
                  </Text>
                </div>
                <Button
                  className={styles.tileRemove}
                  size="small"
                  appearance="subtle"
                  icon={<Dismiss16Regular />}
                  aria-label={`${strings.compose.removeFile}: ${a.name}`}
                  onClick={() => useAttachments.getState().remove(key, a.id)}
                  data-testid="attachment-remove"
                />
              </div>
            );
          })}
        </div>
      )}
      {attachNotice && (
        <Text size={200} block className={styles.notice} data-testid="attach-notice">
          {attachNotice}
        </Text>
      )}
      <LexicalComposer initialConfig={initialConfig}>
        <div className={styles.editorWrap}>
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className={styles.editor}
                aria-label={placeholder}
                aria-description={strings.chat.sendHint}
                data-testid="composer"
              />
            }
            placeholder={<div className={styles.placeholder}>{placeholder}</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <MarkdownShortcutPlugin transformers={OM_TRANSFORMERS} />
        <OnChangePlugin onChange={onChange} ignoreSelectionChange />
        <MentionsPlugin convId={convId} onMenuOpen={setMenuOpen} />
        <EnterToSend onSend={() => void send()} isMenuOpen={isMenuOpen} />
        <EditorReady onReady={setEditor} />
      </LexicalComposer>
      {preview && (
        <div className={styles.preview} data-testid="compose-preview">
          <div className={styles.grow}>
            <Text weight="semibold" size={200} block>
              {preview.title}
            </Text>
            {preview.description && (
              <Text size={200} block>
                {preview.description}
              </Text>
            )}
          </div>
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            aria-label={strings.compose.removePreview}
            onClick={() => {
              dismissedUrl.current = preview.url;
              setPreview(null);
            }}
          />
        </div>
      )}
      <div className={styles.bottom}>
        <Toolbar size="small" className={styles.tools} aria-label={strings.compose.toolbar}>
          {tool(strings.compose.bold, <TextBold20Regular />, () => format('bold'), 'fmt-bold')}
          {tool(strings.compose.italic, <TextItalic20Regular />, () => format('italic'))}
          {tool(strings.compose.strike, <TextStrikethrough20Regular />, () =>
            format('strikethrough'),
          )}
          {tool(strings.compose.code, <Code20Regular />, () => format('code'))}
          {tool(strings.compose.bullets, <TextBulletListLtr20Regular />, () =>
            editor?.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
          )}
          {tool(strings.compose.numbers, <TextNumberListLtr20Regular />, () =>
            editor?.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined),
          )}
          {tool(strings.compose.quote, <TextQuote20Regular />, () => block('quote'))}
          {tool(strings.compose.codeBlock, <CodeBlock20Regular />, () => block('code'))}
          <ToolbarDivider />
          <Popover positioning="above-start" withArrow>
            <PopoverTrigger disableButtonEnhancement>
              <Tooltip content={strings.compose.emoji} relationship="label">
                <ToolbarButton
                  aria-label={strings.compose.emoji}
                  icon={<Emoji20Regular />}
                  data-testid="emoji-button"
                />
              </Tooltip>
            </PopoverTrigger>
            <PopoverSurface aria-label={strings.compose.emoji}>
              {EMOJI_GROUPS.map((g) => (
                <div key={g.name}>
                  <Text size={200} weight="semibold">
                    {g.name}
                  </Text>
                  <div className={styles.emojiGrid}>
                    {g.emoji.map((e) => (
                      <button
                        key={e}
                        type="button"
                        className={styles.emoji}
                        aria-label={e}
                        onClick={() => insertEmoji(e)}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </PopoverSurface>
          </Popover>
          <Tooltip content={strings.compose.urgent} relationship="label">
            <ToggleButton
              appearance="subtle"
              size="small"
              checked={urgent}
              icon={<Important20Regular />}
              aria-label={strings.compose.urgent}
              onClick={() => setUrgent((u) => !u)}
              data-testid="urgent-toggle"
            />
          </Tooltip>
          {announce && (
            <Tooltip content={strings.teams.announcement} relationship="label">
              <ToggleButton
                appearance="subtle"
                size="small"
                checked={headline !== null}
                icon={<Megaphone20Regular />}
                aria-label={strings.teams.announcement}
                onClick={() => setHeadline((h) => (h === null ? '' : null))}
                data-testid="announcement-toggle"
              />
            </Tooltip>
          )}
          {tool(strings.polls.create, <Poll20Regular />, () => setPolling(true), 'poll-button')}
          <Tooltip content={strings.compose.attach} relationship="label">
            <ToolbarButton
              aria-label={strings.compose.attach}
              icon={<Attach20Regular />}
              disabled={!!editing}
              onMouseDown={(e) => e.preventDefault()}
              onClick={pickFiles}
              data-testid="attach"
            />
          </Tooltip>
          <Tooltip content={strings.compose.attachFolder} relationship="label">
            <ToolbarButton
              aria-label={strings.compose.attachFolder}
              icon={<FolderAdd20Regular />}
              disabled={!!editing}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                void core
                  .invoke('files.pickShareFolder', {})
                  .then(({ path }) => path && useAttachments.getState().addFolder(key, path))
                  .catch(() => {})
              }
              data-testid="attach-folder"
            />
          </Tooltip>
          {tool(
            strings.compose.snip,
            <ScreenCut20Regular />,
            () => void core.invoke('screen.snip', {}),
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="file-input"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              queueFiles(convId, files, thread);
            }}
          />
        </Toolbar>
        {polling && (
          <PollDialog convId={convId} thread={thread} onClose={() => setPolling(false)} />
        )}
        <Button
          appearance="transparent"
          icon={<Send20Filled />}
          aria-label={strings.chat.send}
          disabled={empty && queuedCount === 0}
          onClick={() => void send()}
          data-testid="send"
        />
      </div>
    </div>
  );
}

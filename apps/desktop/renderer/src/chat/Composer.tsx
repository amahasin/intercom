import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  makeStyles,
  mergeClasses,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  ToggleButton,
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
  Emoji20Regular,
  Important20Regular,
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
  ListItemNode,
  ListNode,
} from '@lexical/list';
import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown';
import { $createQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';
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
import type { LinkPreview } from '@officemesh/protocol';
import type { PersonView } from '@officemesh/protocol/ipc';
import { act, core, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { EMOJI_GROUPS } from './emoji.ts';
import { $createMentionNode, EDITOR_THEME, MentionNode, OM_TRANSFORMERS } from './lexical.ts';

const useStyles = makeStyles({
  root: {
    margin: `0 ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalL}`,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    ':focus-within': { borderBottomColor: tokens.colorCompoundBrandStroke },
  },
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
  menu: {
    position: 'absolute',
    bottom: '24px',
    minWidth: '220px',
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXS,
    zIndex: 10,
  },
  option: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
    cursor: 'pointer',
  },
  optionActive: { background: tokens.colorSubtleBackgroundSelected },
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

function MentionsPlugin({ onMenuOpen }: { onMenuOpen: (open: boolean) => void }) {
  const styles = useStyles();
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const people = useApp((s) => s.people);
  const triggerFn = useBasicTypeaheadTriggerMatch('@', { minLength: 0 });
  const options = useMemo(
    () =>
      Object.values(people)
        .filter(
          (p) =>
            p.displayName && (!query || p.displayName.toLowerCase().includes(query.toLowerCase())),
        )
        .sort((a, b) => Number(b.online) - Number(a.online))
        .slice(0, 8)
        .map((p) => new PersonOption(p)),
    [people, query],
  );
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
        anchor.current && options.length > 0
          ? createPortal(
              <div className={styles.menu} role="listbox" data-testid="mention-menu">
                {options.map((o, i) => (
                  <div
                    key={o.key}
                    role="option"
                    aria-selected={i === selectedIndex}
                    className={mergeClasses(
                      styles.option,
                      i === selectedIndex && styles.optionActive,
                    )}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectOptionAndCleanUp(o);
                    }}
                  >
                    {o.person.displayName}
                  </div>
                ))}
              </div>,
              anchor.current,
            )
          : null
      }
    />
  );
}

/** Enter sends; Shift+Enter, an open mention menu, or a code block keep Enter's usual meaning. */
function EnterToSend({ onSend, isMenuOpen }: { onSend: () => void; isMenuOpen: () => boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          if (event?.shiftKey || isMenuOpen()) return false;
          let inCode = false;
          editor.getEditorState().read(() => {
            const sel = $getSelection();
            if ($isRangeSelection(sel)) {
              const top = sel.anchor.getNode().getTopLevelElement();
              inCode = $isCodeNode(top);
            }
          });
          if (inCode) return false;
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

/** JPEG thumbnail (max 320 px) for images, made on this PC. */
async function thumbnail(
  file: Blob,
): Promise<{ thumb: string; width: number; height: number } | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const thumb = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (thumb.length > 48_000) return undefined;
    return { thumb, width: bitmap.width, height: bitmap.height };
  } catch {
    return undefined;
  }
}

/** Share files the user attached, pasted or dropped (each becomes its own message). */
export async function shareFiles(
  convId: string,
  files: File[],
  extra: { urgent?: boolean } = {},
): Promise<void> {
  for (const file of files) {
    const path = window.officemesh.pathForFile(file);
    const thumb = file.type.startsWith('image/') ? await thumbnail(file) : undefined;
    const base = {
      convId,
      name:
        file.name ||
        `pasted-${Date.now()}.${(file.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg')}`,
      ...(file.type && { mime: file.type }),
      ...(extra.urgent && { urgent: true }),
      ...thumb,
    };
    await act(convId, () =>
      path
        ? core.invoke('files.share', { ...base, path })
        : file
            .arrayBuffer()
            .then((buf) => core.invoke('files.share', { ...base, data: new Uint8Array(buf) })),
    );
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>()]+/;

export function Composer({ convId, placeholder }: { convId: string; placeholder: string }) {
  const styles = useStyles();
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
  const replyTo = useApp((s) => s.replyTo[convId]);
  const editing = useApp((s) => (s.editing?.convId === convId ? s.editing.message : undefined));

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
    if (!text) return;
    const st = useApp.getState();
    const editingNow = st.editing?.convId === convId ? st.editing.message : undefined;
    const reply = st.replyTo[convId];
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
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, urgent, preview, editor]);

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
        $setBlocksType(sel, () => (kind === 'quote' ? $createQuoteNode() : $createCodeNode()));
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
    void shareFiles(convId, files, { urgent });
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
      className={mergeClasses(styles.root, urgent && styles.urgent)}
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
      {urgent && (
        <div className={styles.banner} style={{ color: tokens.colorPaletteRedForeground1 }}>
          <Important20Regular />
          <Text size={200} weight="semibold">
            {strings.compose.urgentOn}
          </Text>
        </div>
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
        <MentionsPlugin onMenuOpen={setMenuOpen} />
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
        <Toolbar size="small" aria-label={strings.compose.toolbar}>
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
          <Tooltip content={strings.compose.attach} relationship="label">
            <ToolbarButton
              aria-label={strings.compose.attach}
              icon={<Attach20Regular />}
              onMouseDown={(e) => e.preventDefault()}
              onClick={pickFiles}
              data-testid="attach"
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
              void shareFiles(convId, files, { urgent });
            }}
          />
        </Toolbar>
        <Button
          appearance="transparent"
          icon={<Send20Filled />}
          aria-label={strings.chat.send}
          disabled={empty}
          onClick={() => void send()}
          data-testid="send"
        />
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar, Input, makeStyles, Text, tokens } from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import type { PersonView, SearchHit } from '@officemesh/protocol/ipc';
import { shortTime } from '../format.ts';
import { avatarSrc, core, displayName, nameOf, openAt, openChatWith, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  wrap: { position: 'relative', width: '100%', WebkitAppRegion: 'no-drag' },
  panel: {
    position: 'absolute',
    top: '38px',
    left: 0,
    right: 0,
    maxHeight: '60vh',
    overflowY: 'auto',
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow28,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalS,
    zIndex: 100,
  },
  section: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    color: tokens.colorNeutralForeground3,
  },
  item: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    alignItems: 'center',
    width: '100%',
    padding: tokens.spacingHorizontalS,
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: 'transparent',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  mark: { background: tokens.colorPaletteYellowBackground2, color: 'inherit', borderRadius: '2px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

/** Render an FTS snippet, with matches wrapped in U+0001 ... U+0002. */
function Snippet({ text }: { text: string }) {
  const styles = useStyles();
  const parts: ReactNode[] = [];
  text.split('\u0001').forEach((chunk, i) => {
    if (i === 0) return void parts.push(chunk);
    const [hit, rest] = chunk.split('\u0002');
    parts.push(
      <mark key={i} className={styles.mark}>
        {hit}
      </mark>,
      rest ?? '',
    );
  });
  return <Text size={200}>{parts}</Text>;
}

export function SearchBox() {
  const styles = useStyles();
  const people = useApp((s) => s.people);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!text.trim()) return;
    const t = window.setTimeout(() => {
      void core.invoke('search.query', { text, limit: 30 }).then((r) => setHits(r.messages));
    }, 150);
    return () => window.clearTimeout(t);
  }, [text]);

  const needle = text.trim().toLowerCase();
  const shownHits = needle ? hits : [];
  const matchingPeople: PersonView[] = needle
    ? Object.values(people)
        .filter((p) => nameOf(p, p.userId).toLowerCase().includes(needle))
        .slice(0, 5)
    : [];
  const close = () => {
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div
      className={styles.wrap}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
    >
      <Input
        ref={inputRef}
        style={{ width: '100%' }}
        contentBefore={<Search20Regular />}
        placeholder={strings.searchUi.placeholder}
        aria-label={strings.search}
        appearance="filled-darker"
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(_e, d) => {
          setText(d.value);
          setOpen(true);
        }}
        onKeyDown={(e) => e.key === 'Escape' && close()}
        data-testid="search-input"
      />
      {open && needle && (
        <div className={styles.panel} role="listbox" data-testid="search-results">
          {matchingPeople.length > 0 && (
            <Text size={200} weight="semibold" block className={styles.section}>
              {strings.searchUi.people}
            </Text>
          )}
          {matchingPeople.map((p) => (
            <button
              key={p.userId}
              type="button"
              className={styles.item}
              onClick={() => (close(), void openChatWith(p.userId))}
            >
              <Avatar name={nameOf(p, p.userId)} size={24} image={avatarSrc(p.avatarHash)} />
              <Text>{nameOf(p, p.userId)}</Text>
            </button>
          ))}
          <Text size={200} weight="semibold" block className={styles.section}>
            {strings.searchUi.messages}
          </Text>
          {shownHits.length === 0 && (
            <Text size={200} block className={styles.section}>
              {strings.searchUi.none}
            </Text>
          )}
          {shownHits.map((h) => (
            <button
              key={`${h.message.convId}:${h.message.id}`}
              type="button"
              className={styles.item}
              data-testid="search-hit"
              onClick={() => (close(), void openAt(h.message.convId, h.message))}
            >
              <span className={styles.text}>
                <Text size={200} weight="semibold">
                  {displayName(h.message.author)}{' '}
                  <span className={styles.muted}>· {shortTime(h.message.at)}</span>
                </Text>
                <Snippet text={h.snippet} />
              </span>
            </button>
          ))}
          <Text size={100} block className={styles.section}>
            {strings.searchUi.hint}
          </Text>
        </div>
      )}
    </div>
  );
}

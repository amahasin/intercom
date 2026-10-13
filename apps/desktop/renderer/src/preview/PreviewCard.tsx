import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
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
  ArrowForward20Regular,
  FolderOpen20Regular,
  MoreHorizontal20Regular,
  Open20Regular,
} from '@fluentui/react-icons';
import { formatSize } from '../chat/FileCard.tsx';
import { core } from '../state.ts';
import { strings } from '../strings.ts';
import { FileIcon } from './FileIcon.tsx';
import type { PreviewFile, PreviewKind } from './kinds.ts';
import { fileHref } from './source.ts';
import { snippetFor, type Snippet } from './snippet.ts';
import { openFile } from './store.ts';

const useStyles = makeStyles({
  card: {
    width: '340px',
    maxWidth: '100%',
    marginTop: tokens.spacingVerticalXS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow2,
    overflow: 'hidden',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} ${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  title: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  area: {
    position: 'relative',
    display: 'block',
    width: '100%',
    height: '210px',
    padding: 0,
    border: 'none',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground3,
    cursor: 'pointer',
    overflow: 'hidden',
    textAlign: 'left',
  },
  page: {
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    padding: '14px 18px',
    background: '#ffffff',
    color: '#242424',
    fontSize: '11px',
    lineHeight: '1.45',
    overflow: 'hidden',
    // The bottom fades out: it is the top of the file, not all of it.
    maskImage: 'linear-gradient(to bottom, #000 70%, transparent 100%)',
  },
  line: { whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' },
  mono: { fontFamily: 'Consolas, "Cascadia Mono", monospace', fontSize: '10.5px' },
  picture: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'top',
    background: '#ffffff',
  },
  grid: {
    borderCollapse: 'collapse',
    fontSize: '11px',
    width: '100%',
    tableLayout: 'fixed',
    '& td': {
      border: '1px solid #d1d1d1',
      padding: '2px 6px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    '& tr:first-child td': { fontWeight: 600, background: '#f5f5f5' },
  },
  skeleton: { width: '100%', height: '100%', background: tokens.colorNeutralBackground4 },
  centred: { display: 'grid', placeItems: 'center' },
  open: {
    position: 'absolute',
    right: tokens.spacingHorizontalS,
    bottom: tokens.spacingVerticalS,
    width: '32px',
    height: '32px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow4,
  },
  audio: {
    display: 'block',
    width: '100%',
    padding: tokens.spacingHorizontalS,
    boxSizing: 'border-box',
  },
});

/** True once the element has been on screen (so heavy previews are made only for what is seen). */
function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        watch.disconnect();
      }
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref, seen]);
  return seen;
}

function Preview({ snippet }: { snippet: Snippet | undefined }): ReactNode {
  const s = useStyles();
  if (!snippet) return <div className={s.skeleton} />;
  switch (snippet.kind) {
    case 'image':
      return <img className={s.picture} src={snippet.url} alt="" draggable={false} />;
    case 'lines':
      return (
        <div className={s.page}>
          {snippet.lines.map((line, i) => (
            <div key={i} className={mergeClasses(s.line, snippet.mono && s.mono)}>
              {line || ' '}
            </div>
          ))}
        </div>
      );
    case 'table':
      return (
        <div className={s.page}>
          <table className={s.grid}>
            <tbody>
              {snippet.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'none':
      return (
        <div className={mergeClasses(s.skeleton, s.centred)}>
          <FileIcon kind={undefined} size={40} />
        </div>
      );
  }
}

/**
 * A file in a chat bubble: its name with Forward and More, and under it the first page, lines or
 * cells of the file. Clicking opens it in the built-in viewer.
 */
export function PreviewCard({
  file,
  kind,
  onShare,
  below,
}: {
  file: PreviewFile;
  kind: PreviewKind;
  /** Forward the message that carries this file. */
  onShare?: (() => void) | undefined;
  /** Sending progress and the like. */
  below?: ReactNode;
}) {
  const s = useStyles();
  const box = useRef<HTMLDivElement>(null);
  const seen = useSeen(box);
  const [snippet, setSnippet] = useState<Snippet>();
  useEffect(() => {
    if (!seen || kind === 'audio') return;
    let current = true;
    void snippetFor(file).then((made) => current && setSnippet(made));
    return () => {
      current = false;
    };
  }, [seen, file, kind]);
  const pages = snippet?.kind === 'image' ? snippet.pages : undefined;
  const open = () => openFile(file);

  return (
    <div
      ref={box}
      className={s.card}
      data-testid="file-card-preview"
      data-state="complete"
      data-kind={kind}
    >
      <div className={s.head}>
        <FileIcon kind={kind} />
        <div className={s.title}>
          <Text weight="semibold" className={s.name} title={file.name} data-testid="file-name">
            {file.name}
          </Text>
          <Text size={200} className={s.muted}>
            {formatSize(file.size)}
            {pages ? ` · ${strings.preview.pages(pages)}` : ''}
          </Text>
        </div>
        {onShare && (
          <Tooltip content={strings.preview.forward} relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowForward20Regular />}
              onClick={onShare}
              aria-label={strings.preview.forward}
              data-testid="file-forward"
            />
          </Tooltip>
        )}
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button
              size="small"
              appearance="subtle"
              icon={<MoreHorizontal20Regular />}
              aria-label={strings.preview.more}
              data-testid="file-more"
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<Open20Regular />} onClick={open} data-testid="file-menu-preview">
                {strings.preview.open}
              </MenuItem>
              <MenuItem
                icon={<Open20Regular />}
                onClick={() => void core.invoke('files.open', { sha256: file.sha256 })}
                data-testid="file-open"
              >
                {strings.preview.openWithApp}
              </MenuItem>
              <MenuItem
                icon={<FolderOpen20Regular />}
                onClick={() => void core.invoke('files.showInFolder', { sha256: file.sha256 })}
              >
                {strings.files.showInFolder}
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
      {kind === 'audio' ? (
        <audio
          className={s.audio}
          src={seen ? fileHref(file) : undefined}
          controls
          preload="none"
          data-testid="inline-audio"
        />
      ) : (
        <button
          type="button"
          className={s.area}
          onClick={open}
          aria-label={strings.preview.label(file.name)}
          data-testid="file-preview"
          data-ready={snippet !== undefined}
        >
          <Preview snippet={snippet} />
          <span className={s.open} aria-hidden="true">
            <Open20Regular />
          </span>
        </button>
      )}
      {below}
    </div>
  );
}

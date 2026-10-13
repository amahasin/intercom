import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import {
  Button,
  Input,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Tab,
  TabList,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  ChevronDown20Regular,
  ChevronUp20Regular,
  Dismiss20Regular,
  FolderOpen20Regular,
  MoreHorizontal20Regular,
  Open20Regular,
  ScaleFit20Regular,
  Search20Regular,
  ZoomIn20Regular,
  ZoomOut20Regular,
} from '@fluentui/react-icons';
import { formatSize } from '../chat/FileCard.tsx';
import { core } from '../state.ts';
import { strings } from '../strings.ts';
import { FileIcon } from './FileIcon.tsx';
import { MAX_PARSE_BYTES, previewKind, type PreviewKind, type PreviewFile } from './kinds.ts';
import {
  columnName,
  docxToElement,
  pptxSlides,
  xlsxSheets,
  type Deck,
  type DocxView,
  type Sheet,
} from './office.ts';
import { parseCsv } from './grid.ts';
import { loadPdfjs, openPdf, startRender } from './pdf.ts';
import { decodeText, fileHref, readFileBytes } from './source.ts';
import { closePreview, usePreview } from './store.ts';

const useStyles = makeStyles({
  root: {
    position: 'absolute',
    inset: 0,
    zIndex: 30,
    display: 'flex',
    flexDirection: 'column',
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  head: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    minHeight: '56px',
    boxSizing: 'border-box',
    padding: `0 ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
  },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  body: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    background: tokens.colorNeutralBackground3,
  },
  scroll: { flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' },
  pages: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: '12px',
    padding: '24px 24px 96px',
    width: 'max-content',
    minWidth: '100%',
    boxSizing: 'border-box',
  },
  sheetPage: {
    position: 'relative',
    flex: 'none',
    background: '#ffffff',
    boxShadow: tokens.shadow8,
  },
  centre: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXXL,
    textAlign: 'center',
  },
  pill: {
    position: 'absolute',
    left: '50%',
    bottom: tokens.spacingVerticalXL,
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: '999px',
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    zIndex: 3,
  },
  pageInput: {
    width: '42px',
    height: '28px',
    boxSizing: 'border-box',
    textAlign: 'center',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
  },
  divider: {
    width: '1px',
    height: '20px',
    background: tokens.colorNeutralStroke2,
    margin: `0 ${tokens.spacingHorizontalXS}`,
  },
  find: { width: '170px' },
  imageBox: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    display: 'grid',
    placeItems: 'center',
    padding: tokens.spacingHorizontalL,
    boxSizing: 'border-box',
  },
  mediaBox: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    placeItems: 'center',
    padding: tokens.spacingHorizontalL,
  },
  text: {
    margin: 0,
    padding: tokens.spacingHorizontalXL,
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: '13px',
    lineHeight: 1.5,
    whiteSpace: 'pre',
    userSelect: 'text',
    background: tokens.colorNeutralBackground1,
    minHeight: '100%',
    boxSizing: 'border-box',
  },
  grid: {
    borderCollapse: 'separate',
    borderSpacing: 0,
    fontSize: '13px',
    background: tokens.colorNeutralBackground1,
    '& th': {
      position: 'sticky',
      top: 0,
      zIndex: 1,
      background: tokens.colorNeutralBackground3,
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: '3px 10px',
      fontWeight: 600,
      color: tokens.colorNeutralForeground3,
    },
    '& th.row': { left: 0, zIndex: 2, textAlign: 'right', top: 'auto' },
    '& td': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: '3px 10px',
      whiteSpace: 'nowrap',
      maxWidth: '360px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      userSelect: 'text',
    },
  },
  tabs: {
    flex: 'none',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    padding: `0 ${tokens.spacingHorizontalM}`,
  },
  slides: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: '16px',
    padding: '24px',
  },
  slide: {
    width: 'min(880px, 100%)',
    boxSizing: 'border-box',
    padding: '4% 6%',
    background: '#ffffff',
    color: '#242424',
    boxShadow: tokens.shadow8,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    rowGap: '10px',
  },
  note: {
    textAlign: 'center',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    color: tokens.colorNeutralForeground3,
  },
});

// ---------------------------------------------------------------------------------------------
// Loading helpers

/**
 * Runs `load` when `key` changes (and does nothing while `load` is undefined: the thing it
 * needs is not there yet). The result, or the reason it failed; nothing until it is for this key.
 */
function useLoaded<T>(
  load: (() => Promise<T>) | undefined,
  key: unknown,
): { value?: T; error?: string } {
  const [state, setState] = useState<{ key: unknown; value?: T; error?: string }>({
    key: undefined,
  });
  useEffect(() => {
    if (!load) return;
    let current = true;
    load().then(
      (value) => current && setState({ key, value }),
      (error: unknown) =>
        current && setState({ key, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      current = false;
    };
    // `load` is a closure over `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return load && state.key === key ? state : {};
}

function Message({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const s = useStyles();
  return (
    <div className={s.centre} data-testid="viewer-message">
      <Text>{children}</Text>
      {action}
    </div>
  );
}

function Loading() {
  const s = useStyles();
  return (
    <div className={s.centre}>
      <Spinner label={strings.preview.loading} />
    </div>
  );
}

const openWithApp = (file: PreviewFile) => void core.invoke('files.open', { sha256: file.sha256 });

function OpenButton({ file }: { file: PreviewFile }) {
  return (
    <Button appearance="primary" onClick={() => openWithApp(file)}>
      {strings.preview.openWithApp}
    </Button>
  );
}

/** A file read whole, with the way it failed or was too big. */
function useWholeFile(file: PreviewFile, kind: PreviewKind) {
  const limit = MAX_PARSE_BYTES[kind] ?? Infinity;
  return useLoaded(async () => {
    if (file.size > limit) throw new Error(strings.preview.tooLarge(formatSize(file.size)));
    return (await readFileBytes(file, file.size)).bytes;
  }, file.sha256);
}

// ---------------------------------------------------------------------------------------------
// Pictures

const ZOOM_STEP = 1.25;

function ImageBody({ file }: { file: PreviewFile }) {
  const s = useStyles();
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [natural, setNatural] = useState<number>();
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const effective = (): number => {
    if (zoom !== 'fit') return zoom;
    const el = box.current;
    return natural && el ? Math.min(1, (el.clientWidth - 32) / natural) : 1;
  };
  if (failed)
    return <Message action={<OpenButton file={file} />}>{strings.preview.cantRead}</Message>;
  return (
    <>
      <div className={s.imageBox} ref={box} data-testid="viewer-image-box">
        <img
          src={fileHref(file)}
          alt={file.name}
          draggable={false}
          onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
          onError={() => setFailed(true)}
          style={
            zoom === 'fit'
              ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
              : { width: natural ? natural * zoom : undefined, maxWidth: 'none' }
          }
          data-testid="viewer-image"
        />
      </div>
      <div className={s.pill}>
        <Tooltip content={strings.preview.zoomOut} relationship="label">
          <Button
            appearance="subtle"
            icon={<ZoomOut20Regular />}
            onClick={() => setZoom(Math.max(0.1, effective() / ZOOM_STEP))}
            aria-label={strings.preview.zoomOut}
          />
        </Tooltip>
        <Tooltip content={strings.preview.zoomIn} relationship="label">
          <Button
            appearance="subtle"
            icon={<ZoomIn20Regular />}
            onClick={() => setZoom(Math.min(8, effective() * ZOOM_STEP))}
            aria-label={strings.preview.zoomIn}
          />
        </Tooltip>
        <Tooltip content={strings.preview.fit} relationship="label">
          <Button
            appearance="subtle"
            icon={<ScaleFit20Regular />}
            onClick={() => setZoom('fit')}
            aria-label={strings.preview.fit}
          />
        </Tooltip>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// PDF

function markHits(layer: HTMLElement | null, query: string): void {
  if (!layer) return;
  const q = query.trim().toLowerCase();
  for (const span of layer.querySelectorAll('span'))
    span.classList.toggle(
      'pdf-hit',
      q !== '' && (span.textContent ?? '').toLowerCase().includes(q),
    );
}

function PdfPage({
  doc,
  n,
  scale,
  base,
  query,
  root,
  textLayer,
}: {
  doc: PDFDocumentProxy;
  n: number;
  scale: number;
  /** The first page's size at scale 1: what every page is assumed to be until it is drawn. */
  base: { w: number; h: number };
  query: string;
  root: RefObject<HTMLElement | null>;
  textLayer: typeof TextLayer;
}) {
  const s = useStyles();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(n <= 2);
  const [size, setSize] = useState<{ w: number; h: number }>();

  // Only pages near the screen are drawn; far ones give their memory back.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const watch = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      { root: root.current, rootMargin: '1400px 0px' },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [root]);

  useEffect(() => {
    const c = canvas.current;
    const l = layer.current;
    if (!c || !l) return;
    if (!near) {
      c.width = 0;
      c.height = 0;
      l.replaceChildren();
      return;
    }
    let current = true;
    let task: RenderTask | undefined;
    let text: TextLayer | undefined;
    void (async () => {
      const page = await doc.getPage(n);
      if (!current) return;
      const started = startRender(page, c, scale);
      task = started.task;
      setSize({ w: started.width, h: started.height });
      await started.task.promise;
      if (!current) return;
      l.replaceChildren();
      l.style.setProperty('--total-scale-factor', String(scale));
      text = new textLayer({
        textContentSource: page.streamTextContent(),
        container: l,
        viewport: page.getViewport({ scale }),
      });
      await text.render();
      if (current) markHits(l, query);
    })().catch(() => {
      // A cancelled draw (another zoom, or the page left the screen) is not an error.
    });
    return () => {
      current = false;
      task?.cancel();
      text?.cancel();
    };
    // `query` only re-marks (the effect below), it must not redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, n, near, scale, textLayer]);

  useEffect(() => markHits(layer.current, query), [query]);

  const w = size?.w ?? Math.floor(base.w * scale);
  const h = size?.h ?? Math.floor(base.h * scale);
  return (
    <div
      ref={host}
      className={s.sheetPage}
      style={{ width: w, height: h }}
      data-page={n}
      data-testid="pdf-page"
    >
      <canvas ref={canvas} style={{ display: 'block' }} />
      <div ref={layer} className="pdf-text-layer" style={{ width: w, height: h }} />
    </div>
  );
}

function PdfBody({ file }: { file: PreviewFile }) {
  const s = useStyles();
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [width, setWidth] = useState(900);
  const [current, setCurrent] = useState(1);
  const [typed, setTyped] = useState('1');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setHits] = useState<number[]>([]);
  const [hitAt, setHitAt] = useState(0);
  // Matches only count while there is something typed (the last search is kept, not cleared).
  const hits = query.trim() === '' ? [] : found;
  const texts = useRef(new Map<number, Promise<string>>());

  const loaded = useLoaded(async () => {
    const [doc, pdfjs] = await Promise.all([openPdf(file), loadPdfjs()]);
    const first = await doc.getPage(1);
    const view = first.getViewport({ scale: 1 });
    return { doc, TextLayer: pdfjs.TextLayer, base: { w: view.width, h: view.height } };
  }, file.sha256);
  const doc = loaded.value?.doc;
  useEffect(() => () => void doc?.loadingTask.destroy(), [doc]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [doc]);

  const base = loaded.value?.base;
  const fitScale = base ? Math.min(4, Math.max(0.25, (width - 48) / base.w)) : 1;
  const scale = zoom === 'fit' ? fitScale : zoom;
  const pages = doc?.numPages ?? 0;

  const goTo = useCallback((n: number) => {
    const el = scroller.current?.querySelector(`[data-page="${n}"]`);
    el?.scrollIntoView({ block: 'start' });
  }, []);

  // Which page is at the top.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    let at = 1;
    for (const page of el.querySelectorAll<HTMLElement>('[data-page]')) {
      if (page.offsetTop - 70 <= el.scrollTop) at = Number(page.dataset.page);
      else break;
    }
    setCurrent(at);
    setTyped(String(at));
  }, []);

  // Ctrl + wheel zooms, as in a browser.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => {
        const now = z === 'fit' ? fitScale : z;
        return Math.min(5, Math.max(0.25, e.deltaY < 0 ? now * ZOOM_STEP : now / ZOOM_STEP));
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [doc, fitScale]);

  // Search: which pages have the words (page text is read once and remembered).
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!doc || !q) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      const pages: number[] = [];
      for (let i = 1; i <= doc.numPages && live; i++) {
        let read = texts.current.get(i);
        if (!read) {
          read = doc
            .getPage(i)
            .then((p) => p.getTextContent())
            .then((c) =>
              c.items
                .map((it) => ('str' in it ? it.str : ''))
                .join(' ')
                .toLowerCase(),
            );
          texts.current.set(i, read);
        }
        if ((await read).includes(q)) pages.push(i);
      }
      if (!live) return;
      setHits(pages);
      setHitAt(0);
      if (pages[0]) goTo(pages[0]);
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, doc, goTo]);

  const stepHit = (by: number) => {
    if (hits.length === 0) return;
    const next = (hitAt + by + hits.length) % hits.length;
    setHitAt(next);
    goTo(hits[next]!);
  };

  if (loaded.error)
    return <Message action={<OpenButton file={file} />}>{strings.preview.cantRead}</Message>;
  if (!doc || !base || !loaded.value) return <Loading />;

  return (
    <>
      <div className={s.scroll} ref={scroller} onScroll={onScroll} data-testid="viewer-pdf">
        <div className={s.pages}>
          {Array.from({ length: pages }, (_, i) => (
            <PdfPage
              key={i}
              doc={doc}
              n={i + 1}
              scale={scale}
              base={base}
              query={query}
              root={scroller}
              textLayer={loaded.value!.TextLayer}
            />
          ))}
        </div>
      </div>
      <div className={s.pill} data-testid="viewer-pill">
        {searching && (
          <>
            <Input
              className={s.find}
              size="small"
              autoFocus
              value={query}
              placeholder={strings.preview.find}
              onChange={(_e, d) => setQuery(d.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') stepHit(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearching(false);
                  setQuery('');
                }
              }}
              data-testid="viewer-find"
            />
            <Text size={200} className={s.muted} data-testid="viewer-find-count">
              {query.trim() === ''
                ? ''
                : hits.length === 0
                  ? strings.preview.noMatches
                  : strings.preview.matches(hitAt + 1, hits.length)}
            </Text>
            <span className={s.divider} />
          </>
        )}
        <Tooltip content={strings.preview.previous} relationship="label">
          <Button
            appearance="subtle"
            icon={<ChevronUp20Regular />}
            disabled={current <= 1}
            onClick={() => goTo(current - 1)}
            aria-label={strings.preview.previous}
            data-testid="viewer-prev"
          />
        </Tooltip>
        <Tooltip content={strings.preview.next} relationship="label">
          <Button
            appearance="subtle"
            icon={<ChevronDown20Regular />}
            disabled={current >= pages}
            onClick={() => goTo(current + 1)}
            aria-label={strings.preview.next}
            data-testid="viewer-next"
          />
        </Tooltip>
        <input
          className={s.pageInput}
          value={typed}
          inputMode="numeric"
          aria-label={strings.preview.page}
          onChange={(e) => setTyped(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const n = Math.min(pages, Math.max(1, Number(typed) || 1));
            setTyped(String(n));
            goTo(n);
          }}
          onBlur={() => setTyped(String(current))}
          data-testid="viewer-page-input"
        />
        <Text size={300} data-testid="viewer-page-count">
          {strings.preview.pageOf(pages)}
        </Text>
        <span className={s.divider} />
        <Tooltip content={strings.preview.zoomOut} relationship="label">
          <Button
            appearance="subtle"
            icon={<ZoomOut20Regular />}
            onClick={() => setZoom(Math.max(0.25, scale / ZOOM_STEP))}
            aria-label={strings.preview.zoomOut}
            data-testid="viewer-zoom-out"
          />
        </Tooltip>
        <Tooltip content={strings.preview.zoomIn} relationship="label">
          <Button
            appearance="subtle"
            icon={<ZoomIn20Regular />}
            onClick={() => setZoom(Math.min(5, scale * ZOOM_STEP))}
            aria-label={strings.preview.zoomIn}
            data-testid="viewer-zoom-in"
          />
        </Tooltip>
        <Tooltip content={strings.preview.fit} relationship="label">
          <Button
            appearance="subtle"
            icon={<ScaleFit20Regular />}
            onClick={() => setZoom('fit')}
            aria-label={strings.preview.fit}
            data-testid="viewer-fit"
          />
        </Tooltip>
        <Tooltip content={strings.preview.search} relationship="label">
          <Button
            appearance={searching ? 'primary' : 'subtle'}
            icon={<Search20Regular />}
            onClick={() => {
              setSearching((on) => !on);
              if (searching) setQuery('');
            }}
            aria-label={strings.preview.search}
            data-testid="viewer-search"
          />
        </Tooltip>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Text, tables, Word, PowerPoint, media

function TextBody({ file }: { file: PreviewFile }) {
  const s = useStyles();
  const limit = MAX_PARSE_BYTES.text!;
  const loaded = useLoaded(async () => {
    const { bytes, truncated } = await readFileBytes(file, limit);
    return { text: decodeText(bytes), truncated };
  }, file.sha256);
  if (loaded.error)
    return <Message action={<OpenButton file={file} />}>{strings.preview.cantRead}</Message>;
  if (!loaded.value) return <Loading />;
  if (loaded.value.text === undefined)
    return <Message action={<OpenButton file={file} />}>{strings.preview.notText}</Message>;
  return (
    <div className={s.scroll}>
      <pre className={s.text} data-testid="viewer-text">
        {loaded.value.text}
      </pre>
      {loaded.value.truncated && (
        <Text block size={200} className={s.note}>
          {strings.preview.truncated(formatSize(limit))}
        </Text>
      )}
    </div>
  );
}

function SheetView({ sheets, truncatedAt }: { sheets: Sheet[]; truncatedAt?: string }) {
  const s = useStyles();
  const [active, setActive] = useState(0);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const columns = useMemo(() => Math.max(1, ...(sheet?.rows.map((r) => r.length) ?? [1])), [sheet]);
  if (!sheet) return <Message>{strings.preview.emptySheet}</Message>;
  return (
    <>
      <div className={s.scroll} data-testid="viewer-sheet">
        {sheet.rows.length === 0 ? (
          <Message>{strings.preview.emptySheet}</Message>
        ) : (
          <table className={s.grid}>
            <thead>
              <tr>
                <th className="row" />
                {Array.from({ length: columns }, (_, c) => (
                  <th key={c}>{columnName(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  <th className="row">{r + 1}</th>
                  {Array.from({ length: columns }, (_, c) => (
                    <td key={c} title={row[c]}>
                      {row[c] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(sheet.truncated || truncatedAt) && (
          <Text block size={200} className={s.note}>
            {truncatedAt ?? strings.preview.gridTruncated}
          </Text>
        )}
      </div>
      {sheets.length > 1 && (
        <TabList
          className={s.tabs}
          size="small"
          selectedValue={String(active)}
          onTabSelect={(_e, d) => setActive(Number(d.value))}
          data-testid="viewer-sheet-tabs"
        >
          {sheets.map((x, i) => (
            <Tab key={i} value={String(i)}>
              {x.name}
            </Tab>
          ))}
        </TabList>
      )}
    </>
  );
}

function XlsxBody({ file }: { file: PreviewFile }) {
  const bytes = useWholeFile(file, 'xlsx');
  const sheets = useLoaded(
    bytes.value ? async () => xlsxSheets(bytes.value!) : undefined,
    bytes.value,
  );
  if (bytes.error || sheets.error)
    return (
      <Message action={<OpenButton file={file} />}>
        {bytes.error ?? strings.preview.cantRead}
      </Message>
    );
  if (!sheets.value) return <Loading />;
  return <SheetView sheets={sheets.value} />;
}

function CsvBody({ file }: { file: PreviewFile }) {
  const limit = MAX_PARSE_BYTES.csv!;
  const loaded = useLoaded(async () => {
    const { bytes, truncated } = await readFileBytes(file, limit);
    const text = decodeText(bytes);
    return { text, truncated };
  }, file.sha256);
  const sheets = useMemo(
    () =>
      loaded.value?.text === undefined
        ? undefined
        : [parseCsv(loaded.value.text, /\.tsv$/i.test(file.name))],
    [loaded.value, file.name],
  );
  if (loaded.error)
    return <Message action={<OpenButton file={file} />}>{strings.preview.cantRead}</Message>;
  if (!loaded.value) return <Loading />;
  if (!sheets)
    return <Message action={<OpenButton file={file} />}>{strings.preview.notText}</Message>;
  return (
    <SheetView
      sheets={sheets}
      {...(loaded.value.truncated && { truncatedAt: strings.preview.truncated(formatSize(limit)) })}
    />
  );
}

function DocxBody({ file }: { file: PreviewFile }) {
  const s = useStyles();
  const holder = useRef<HTMLDivElement>(null);
  const bytes = useWholeFile(file, 'docx');
  const view = useLoaded<DocxView>(
    bytes.value ? async () => docxToElement(bytes.value!) : undefined,
    bytes.value,
  );
  const page = view.value;
  useEffect(() => {
    if (!page || !holder.current) return;
    holder.current.replaceChildren(page.element);
    return page.dispose;
  }, [page]);
  if (bytes.error || view.error)
    return (
      <Message action={<OpenButton file={file} />}>
        {bytes.error ?? strings.preview.cantRead}
      </Message>
    );
  return (
    <div className={s.scroll} data-testid="viewer-docx">
      {!page && <Loading />}
      <div ref={holder} />
    </div>
  );
}

function PptxBody({ file }: { file: PreviewFile }) {
  const s = useStyles();
  const bytes = useWholeFile(file, 'pptx');
  const deck = useLoaded<Deck>(
    bytes.value ? async () => pptxSlides(bytes.value!) : undefined,
    bytes.value,
  );
  if (bytes.error || deck.error)
    return (
      <Message action={<OpenButton file={file} />}>
        {bytes.error ?? strings.preview.cantRead}
      </Message>
    );
  if (!deck.value) return <Loading />;
  return (
    <div className={s.scroll} data-testid="viewer-pptx">
      <Text block size={200} className={s.note}>
        {strings.preview.slidesNote}
      </Text>
      <div className={s.slides}>
        {deck.value.slides.map((slide, i) => (
          <div key={i} className={s.slide} style={{ aspectRatio: String(deck.value!.ratio) }}>
            <Text size={200} style={{ color: '#767676' }}>
              {strings.preview.slide(i + 1)}
            </Text>
            {slide.title && (
              <Text size={600} weight="semibold" block style={{ color: '#242424' }}>
                {slide.title}
              </Text>
            )}
            {slide.lines.map((line, j) => (
              <Text
                key={j}
                size={300}
                block
                style={{ color: '#242424', paddingLeft: line.level * 20 }}
              >
                {line.text}
              </Text>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MediaBody({ file, kind }: { file: PreviewFile; kind: 'video' | 'audio' }) {
  const s = useStyles();
  return (
    <div className={s.mediaBox}>
      {kind === 'video' ? (
        <video
          src={fileHref(file)}
          controls
          autoPlay
          style={{ maxWidth: '100%', maxHeight: '100%' }}
          data-testid="viewer-video"
        />
      ) : (
        <audio src={fileHref(file)} controls autoPlay data-testid="viewer-audio" />
      )}
    </div>
  );
}

function Body({ file, kind }: { file: PreviewFile; kind: PreviewKind }) {
  switch (kind) {
    case 'image':
      return <ImageBody file={file} />;
    case 'pdf':
      return <PdfBody file={file} />;
    case 'text':
      return <TextBody file={file} />;
    case 'csv':
      return <CsvBody file={file} />;
    case 'xlsx':
      return <XlsxBody file={file} />;
    case 'docx':
      return <DocxBody file={file} />;
    case 'pptx':
      return <PptxBody file={file} />;
    case 'video':
    case 'audio':
      return <MediaBody file={file} kind={kind} />;
  }
}

// ---------------------------------------------------------------------------------------------

function Viewer({ file }: { file: PreviewFile }) {
  const s = useStyles();
  const kind = previewKind(file);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closePreview();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <div
      className={s.root}
      role="dialog"
      aria-label={strings.preview.label(file.name)}
      data-testid="file-viewer"
    >
      <div className={s.head}>
        <div className={s.title}>
          <FileIcon kind={kind} />
          <Text
            size={400}
            weight="semibold"
            className={s.name}
            title={file.name}
            data-testid="viewer-title"
          >
            {file.name}
          </Text>
          <Text size={200} className={s.muted}>
            {formatSize(file.size)}
          </Text>
        </div>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button
              appearance="subtle"
              icon={<MoreHorizontal20Regular />}
              aria-label={strings.preview.more}
              data-testid="viewer-more"
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<Open20Regular />} onClick={() => openWithApp(file)}>
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
        <Button icon={<Dismiss20Regular />} onClick={closePreview} data-testid="viewer-close">
          {strings.preview.close}
        </Button>
      </div>
      <div className={s.body}>{kind ? <Body file={file} kind={kind} /> : <Loading />}</div>
    </div>
  );
}

/** Mounted once over the content area of the main window: shows the file that was opened. */
export function PreviewHost() {
  const file = usePreview((st) => st.file);
  return file ? <Viewer key={file.sha256} file={file} /> : null;
}

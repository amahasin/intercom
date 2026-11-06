/**
 * Reading Word, Excel and PowerPoint files without Office: they are zip files of XML.
 * Everything is built as DOM nodes with `textContent`, so nothing from a file is ever parsed
 * as HTML. Names are matched by their local part (no namespace addresses are needed).
 */
import { unzipSync } from 'fflate';
import { DEFAULT_THEME, INDEXED, THEME_ORDER, isHex, tinted } from './color.ts';
import { MAX_COLS, MAX_ROWS, type CellLook, type Sheet, type SheetLook } from './grid.ts';

export type { Sheet };

export type Zip = Record<string, Uint8Array>;

const MAX_ENTRY_BYTES = 48 * 1024 * 1024;

/** The wanted entries of a zip, each only as big as is sensible to open. */
export function unzip(bytes: Uint8Array, want: (name: string) => boolean): Zip {
  return unzipSync(bytes, {
    filter: (entry) => want(entry.name) && entry.originalSize <= MAX_ENTRY_BYTES,
  });
}

const decoder = new TextDecoder('utf-8');

export function xml(zip: Zip, name: string): Element | undefined {
  const data = zip[name];
  if (!data) return undefined;
  const doc = new DOMParser().parseFromString(decoder.decode(data), 'application/xml');
  return doc.getElementsByTagName('parsererror').length > 0 ? undefined : doc.documentElement;
}

export const kids = (el: Element | undefined | null, name?: string): Element[] =>
  el ? [...el.children].filter((c) => name === undefined || c.localName === name) : [];
export const kid = (el: Element | undefined | null, name: string): Element | undefined =>
  kids(el, name)[0];
/** All descendants with this local name. */
export function all(el: Element | undefined | null, name: string): Element[] {
  if (!el) return [];
  const found: Element[] = [];
  const walk = (node: Element) => {
    for (const c of node.children) {
      if (c.localName === name) found.push(c);
      walk(c);
    }
  };
  walk(el);
  return found;
}
/**
 * An attribute by its local name ("val" for w:val), whatever the prefix. `prefixed` asks for the
 * one that has a prefix (r:id, not id: a slide id has both).
 */
export function attr(
  el: Element | undefined | null,
  name: string,
  prefixed = false,
): string | undefined {
  if (!el) return undefined;
  for (const a of el.attributes)
    if (a.localName === name && (!prefixed || a.prefix)) return a.value;
  return undefined;
}
export const textOf = (el: Element | undefined | null, name: string): string =>
  all(el, name)
    .map((t) => t.textContent ?? '')
    .join('');

/** Relationship id -> target, from a `.rels` part. */
export function relations(zip: Zip, part: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of all(xml(zip, part), 'Relationship'))
    map.set(attr(r, 'Id') ?? '', attr(r, 'Target') ?? '');
  return map;
}
/** `target` as a path inside the zip, relative to the folder of `from`. */
export function resolvePath(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** The colours of a theme part by slot name (dk1, accent1...); Office's own for any it lacks. */
export function themePalette(zip: Zip, part: string): Record<string, string> {
  const palette: Record<string, string> = { ...DEFAULT_THEME };
  for (const slot of kids(all(xml(zip, part), 'clrScheme')[0])) {
    const value = attr(kid(slot, 'srgbClr'), 'val') ?? attr(kid(slot, 'sysClr'), 'lastClr');
    if (isHex(value)) palette[slot.localName] = value.toUpperCase();
  }
  return palette;
}

/** The small picture an Office file may carry of its first page or slide. */
export function embeddedThumbnail(bytes: Uint8Array): string | undefined {
  try {
    const zip = unzip(bytes, (n) => /^docProps\/thumbnail\.(jpe?g|png)$/i.test(n));
    const name = Object.keys(zip)[0];
    if (!name) return undefined;
    const type = /png$/i.test(name) ? 'image/png' : 'image/jpeg';
    return URL.createObjectURL(new Blob([zip[name]! as BlobPart], { type }));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Word

/** 1 -> a, 26 -> z, 27 -> aa. */
export function letters(n: number): string {
  let out = '';
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26))
    out = String.fromCharCode(97 + ((i - 1) % 26)) + out;
  return out;
}

/** The first lines of a Word document, as plain text (for the chat bubble). */
export function docxLines(bytes: Uint8Array, max = 14): string[] {
  const zip = unzip(bytes, (n) => n === 'word/document.xml');
  const lines: string[] = [];
  for (const p of all(kid(xml(zip, 'word/document.xml'), 'body'), 'p')) {
    const text = textOf(p, 't').trim();
    if (text) lines.push(text);
    if (lines.length >= max) break;
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Excel

type CellFormat =
  | { kind: 'date'; date: boolean; time: boolean }
  | { kind: 'number'; decimals: number; thousands: boolean; percent: boolean }
  | { kind: 'general' };

/** Excel's built-in formats: 14-17 dates, 18-21 times, 22 both, 45-47 durations. */
function builtinFormat(id: number): CellFormat {
  if ([14, 15, 16, 17].includes(id)) return { kind: 'date', date: true, time: false };
  if (id === 22) return { kind: 'date', date: true, time: true };
  if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47))
    return { kind: 'date', date: false, time: true };
  const numbers: Record<number, [number, boolean, boolean]> = {
    1: [0, false, false],
    2: [2, false, false],
    3: [0, true, false],
    4: [2, true, false],
    9: [0, false, true],
    10: [2, false, true],
  };
  const n = numbers[id];
  return n
    ? { kind: 'number', decimals: n[0], thousands: n[1], percent: n[2] }
    : { kind: 'general' };
}

function formatFromCode(code: string): CellFormat {
  const plain = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
  if (/[dmyhs]/i.test(plain.replace(/e[+-]/gi, ''))) {
    return { kind: 'date', date: /[dy]/i.test(plain), time: /[hs]|AM\/PM/i.test(plain) };
  }
  const afterPoint = /\.([0#?]+)/.exec(plain);
  return {
    kind: 'number',
    decimals: afterPoint ? afterPoint[1]!.length : 0,
    thousands: plain.includes(','),
    percent: plain.includes('%'),
  };
}

function cellText(value: string, format: CellFormat): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (format.kind === 'date') {
    const d = new Date(Math.round((n - 25569) * 86_400_000));
    if (Number.isNaN(d.getTime())) return value;
    const day = format.date ? d.toLocaleDateString(undefined, { timeZone: 'UTC' }) : '';
    const time = format.time
      ? d.toLocaleTimeString(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
      : '';
    return [day, time].filter(Boolean).join(' ');
  }
  if (format.kind === 'number') {
    const v = format.percent ? n * 100 : n;
    return (
      v.toLocaleString(undefined, {
        minimumFractionDigits: format.decimals,
        maximumFractionDigits: format.decimals,
        useGrouping: format.thousands,
      }) + (format.percent ? '%' : '')
    );
  }
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(11)));
}

/** "C5" -> 2. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** 0 -> "A", 27 -> "AB". */
export const columnName = (index: number): string => letters(index + 1).toUpperCase();

const BORDER_WIDTH: Record<string, string> = {
  hair: '1px',
  thin: '1px',
  dotted: '1px',
  dashed: '1px',
  medium: '2px',
  mediumDashed: '2px',
  thick: '3px',
  double: '3px',
};

/**
 * What each cell format (`s="3"`) looks like: its font, fill, borders and alignment, by index.
 * A format that changes nothing is left out (most cells), so a plain sheet carries no styles.
 */
function cellLooks(
  styles: Element | undefined,
  theme: Record<string, string>,
): Array<CellLook | undefined> {
  const colour = (el: Element | undefined): string | undefined => {
    if (!el) return undefined;
    const rgb = attr(el, 'rgb');
    const slot = attr(el, 'theme');
    const indexed = attr(el, 'indexed');
    const base = rgb
      ? rgb.slice(-6)
      : slot !== undefined
        ? theme[THEME_ORDER[Number(slot)] ?? '']
        : indexed !== undefined
          ? INDEXED[Number(indexed)]
          : undefined;
    if (!isHex(base)) return undefined;
    return `#${tinted(base, Number(attr(el, 'tint') ?? '0'))}`;
  };
  const on = (el: Element | undefined): boolean => el !== undefined && attr(el, 'val') !== '0';

  const fonts = kids(kid(styles, 'fonts'), 'font').map((f): CellLook => {
    const color = colour(kid(f, 'color'));
    const size = Number(attr(kid(f, 'sz'), 'val'));
    const name = attr(kid(f, 'name'), 'val');
    return {
      ...(on(kid(f, 'b')) && { bold: true }),
      ...(on(kid(f, 'i')) && { italic: true }),
      ...(kid(f, 'u') && attr(kid(f, 'u'), 'val') !== 'none' && { underline: true }),
      ...(on(kid(f, 'strike')) && { strike: true }),
      ...(color && { color }),
      ...(size > 0 && { size }),
      ...(name && { font: name }),
    };
  });
  const fills = kids(kid(styles, 'fills'), 'fill').map((f) => {
    const pattern = kid(f, 'patternFill');
    return attr(pattern, 'patternType') === 'solid' ? colour(kid(pattern, 'fgColor')) : undefined;
  });
  const borders = kids(kid(styles, 'borders'), 'border').map((b) => {
    const out: Pick<CellLook, 'top' | 'right' | 'bottom' | 'left'> = {};
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const el = kid(b, side);
      const style = attr(el, 'style');
      if (!style || style === 'none') continue;
      const line = style.includes('ash') || style === 'dotted' ? 'dashed' : 'solid';
      out[side] =
        `${BORDER_WIDTH[style] ?? '1px'} ${line} ${colour(kid(el, 'color')) ?? '#000000'}`;
    }
    return out;
  });

  return kids(kid(styles, 'cellXfs'), 'xf').map((xf) => {
    const font = Number(attr(xf, 'fontId') ?? '0');
    const fill = fills[Number(attr(xf, 'fillId') ?? '0')];
    const align = kid(xf, 'alignment');
    const horizontal = attr(align, 'horizontal');
    const vertical = attr(align, 'vertical');
    const look: CellLook = {
      // Font 0 is the workbook's own default, drawn as the page's own text.
      ...(font > 0 ? fonts[font] : {}),
      ...borders[Number(attr(xf, 'borderId') ?? '0')],
      ...(fill && { fill }),
      ...((horizontal === 'center' || horizontal === 'right' || horizontal === 'left') && {
        align: horizontal,
      }),
      ...(horizontal === 'centerContinuous' && { align: 'center' as const }),
      ...((vertical === 'top' || vertical === 'center') && {
        valign: vertical === 'center' ? ('middle' as const) : ('top' as const),
      }),
      ...(attr(align, 'wrapText') === '1' && { wrap: true }),
    };
    return Object.keys(look).length > 0 ? look : undefined;
  });
}

/** Excel's column width in characters as pixels (7 px a character and 5 px of padding). */
const columnPixels = (width: number): number => Math.round(width * 7 + 5);

/** A sheet's own layout: column widths, merged cells, frozen panes, hidden rows and columns. */
function sheetLook(root: Element | undefined): SheetLook {
  const look: SheetLook = {
    cols: [],
    rows: [],
    cells: new Map(),
    merges: [],
    frozen: { rows: 0, cols: 0 },
    hiddenCols: new Set(),
    hiddenRows: new Set(),
    gridlines: true,
  };
  const standard = Number(attr(kid(root, 'sheetFormatPr'), 'defaultColWidth'));
  for (const c of kids(kid(root, 'cols'), 'col')) {
    const from = Math.max(1, Number(attr(c, 'min') ?? '1'));
    const to = Math.min(MAX_COLS, Number(attr(c, 'max') ?? from));
    const width = Number(attr(c, 'width'));
    for (let i = from; i <= to; i++) {
      if (width > 0) look.cols[i - 1] = columnPixels(width);
      if (attr(c, 'hidden') === '1') look.hiddenCols.add(i - 1);
    }
  }
  if (standard > 0) for (let i = 0; i < MAX_COLS; i++) look.cols[i] ??= columnPixels(standard);
  for (const m of all(kid(root, 'mergeCells'), 'mergeCell')) {
    const [from, to] = (attr(m, 'ref') ?? '').split(':');
    if (!from || !to) continue;
    const row = Number(/\d+/.exec(from)?.[0]) - 1;
    const rows = Number(/\d+/.exec(to)?.[0]) - row;
    const col = columnIndex(from);
    const cols = columnIndex(to) - col + 1;
    if (row >= 0 && col >= 0 && col < MAX_COLS && (rows > 1 || cols > 1))
      look.merges.push({ row, col, rows, cols: Math.min(cols, MAX_COLS - col) });
  }
  const view = all(kid(root, 'sheetViews'), 'sheetView')[0];
  if (attr(view, 'showGridLines') === '0') look.gridlines = false;
  const pane = kid(view, 'pane');
  if (pane && attr(pane, 'state') === 'frozen')
    look.frozen = {
      rows: Math.min(50, Number(attr(pane, 'ySplit') ?? '0') || 0),
      cols: Math.min(10, Number(attr(pane, 'xSplit') ?? '0') || 0),
    };
  return look;
}

/** The sheets of an Excel file as grids of text (dates and number formats applied). */
export function xlsxSheets(bytes: Uint8Array, onlyFirst = false): Sheet[] {
  const zip = unzip(
    bytes,
    (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      n === 'xl/styles.xml' ||
      n === 'xl/theme/theme1.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(n),
  );
  const workbook = xml(zip, 'xl/workbook.xml');
  if (!workbook) throw new Error('This is not an Excel workbook that can be read.');
  const rels = relations(zip, 'xl/_rels/workbook.xml.rels');

  const strings = kids(xml(zip, 'xl/sharedStrings.xml'), 'si').map((si) =>
    all(si, 't')
      .filter((t) => t.parentElement?.localName !== 'rPh')
      .map((t) => t.textContent ?? '')
      .join(''),
  );

  const styles = xml(zip, 'xl/styles.xml');
  const custom = new Map<number, string>();
  for (const f of all(kid(styles, 'numFmts'), 'numFmt'))
    custom.set(Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '');
  const formats = kids(kid(styles, 'cellXfs'), 'xf').map((xf): CellFormat => {
    const id = Number(attr(xf, 'numFmtId') ?? '0');
    const code = custom.get(id);
    return code ? formatFromCode(code) : builtinFormat(id);
  });

  const looks = cellLooks(styles, themePalette(zip, 'xl/theme/theme1.xml'));

  const sheets: Sheet[] = [];
  for (const s of all(kid(workbook, 'sheets'), 'sheet')) {
    if (['hidden', 'veryHidden'].includes(attr(s, 'state') ?? '')) continue;
    const target = rels.get(attr(s, 'id', true) ?? '');
    const root = target ? xml(zip, resolvePath('xl/workbook.xml', target)) : undefined;
    const rows: string[][] = [];
    const look = sheetLook(root);
    let truncated = false;
    let rowNumber = 0;
    for (const row of kids(kid(root, 'sheetData'), 'row')) {
      rowNumber = Number(attr(row, 'r') ?? rowNumber + 1);
      if (rowNumber > MAX_ROWS) {
        truncated = true;
        break;
      }
      const cells: string[] = (rows[rowNumber - 1] = []);
      const height = Number(attr(row, 'ht'));
      if (height > 0) look.rows[rowNumber - 1] = Math.round((height * 96) / 72);
      if (attr(row, 'hidden') === '1') look.hiddenRows.add(rowNumber - 1);
      let col = 0;
      for (const c of kids(row, 'c')) {
        const ref = attr(c, 'r');
        col = ref ? columnIndex(ref) : col;
        if (col >= MAX_COLS) {
          truncated = true;
          col++;
          continue;
        }
        const type = attr(c, 't');
        const raw = kid(c, 'v')?.textContent ?? '';
        let text = '';
        if (type === 's') text = strings[Number(raw)] ?? '';
        else if (type === 'inlineStr') text = textOf(kid(c, 'is'), 't');
        else if (type === 'b') text = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e') text = raw;
        else if (raw !== '')
          text = cellText(raw, formats[Number(attr(c, 's') ?? '0')] ?? { kind: 'general' });
        cells[col] = text;
        const cellLook = looks[Number(attr(c, 's') ?? '0')];
        if (cellLook) look.cells.set((rowNumber - 1) * MAX_COLS + col, cellLook);
        col++;
      }
    }
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    sheets.push({ name: attr(s, 'name') ?? `Sheet ${sheets.length + 1}`, rows, truncated, look });
    if (onlyFirst) break;
  }
  return sheets;
}

// ---------------------------------------------------------------------------------------------
// PowerPoint

export interface Slide {
  title: string;
  lines: Array<{ text: string; level: number }>;
}

export interface Deck {
  slides: Slide[];
  /** Width / height of a slide. */
  ratio: number;
}

/** The text of every slide, in order. The layout and the pictures are not drawn. */
export function pptxSlides(bytes: Uint8Array, max = 400): Deck {
  const zip = unzip(
    bytes,
    (n) =>
      n === 'ppt/presentation.xml' ||
      n === 'ppt/_rels/presentation.xml.rels' ||
      /^ppt\/slides\/[^/]+\.xml$/.test(n),
  );
  const presentation = xml(zip, 'ppt/presentation.xml');
  if (!presentation) throw new Error('This is not a PowerPoint file that can be read.');
  const rels = relations(zip, 'ppt/_rels/presentation.xml.rels');
  const size = all(presentation, 'sldSz')[0];
  const cx = Number(attr(size, 'cx'));
  const cy = Number(attr(size, 'cy'));
  const slides: Slide[] = [];
  for (const id of all(kid(presentation, 'sldIdLst'), 'sldId').slice(0, max)) {
    const target = rels.get(attr(id, 'id', true) ?? '');
    const root = target ? xml(zip, resolvePath('ppt/presentation.xml', target)) : undefined;
    let title = '';
    const lines: Slide['lines'] = [];
    for (const shape of all(kid(root, 'cSld'), 'sp')) {
      const type = attr(all(shape, 'ph')[0], 'type');
      const isTitle = type === 'title' || type === 'ctrTitle';
      for (const p of all(kid(shape, 'txBody'), 'p')) {
        const text = textOf(p, 't').trim();
        if (!text) continue;
        if (isTitle && !title) title = text;
        else lines.push({ text, level: Number(attr(kid(p, 'pPr'), 'lvl') ?? '0') });
      }
    }
    for (const t of all(root, 'tbl'))
      for (const tr of all(t, 'tr'))
        lines.push({
          text: all(tr, 'tc')
            .map((tc) => textOf(tc, 't'))
            .join('  |  '),
          level: 0,
        });
    slides.push({ title, lines });
  }
  return { slides, ratio: cx > 0 && cy > 0 ? cx / cy : 16 / 9 };
}

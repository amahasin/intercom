/**
 * Reading Word, Excel and PowerPoint files without Office: they are zip files of XML.
 * Everything is built as DOM nodes with `textContent`, so nothing from a file is ever parsed
 * as HTML. Names are matched by their local part (no namespace addresses are needed).
 */
import { unzipSync } from 'fflate';
import { MAX_COLS, MAX_ROWS, type Sheet } from './grid.ts';

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

const kids = (el: Element | undefined | null, name?: string): Element[] =>
  el ? [...el.children].filter((c) => name === undefined || c.localName === name) : [];
const kid = (el: Element | undefined | null, name: string): Element | undefined =>
  kids(el, name)[0];
/** All descendants with this local name. */
function all(el: Element | undefined | null, name: string): Element[] {
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
function attr(el: Element | undefined | null, name: string, prefixed = false): string | undefined {
  if (!el) return undefined;
  for (const a of el.attributes)
    if (a.localName === name && (!prefixed || a.prefix)) return a.value;
  return undefined;
}
const textOf = (el: Element | undefined | null, name: string): string =>
  all(el, name)
    .map((t) => t.textContent ?? '')
    .join('');

/** Relationship id -> target, from a `.rels` part. */
function relations(zip: Zip, part: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of all(xml(zip, part), 'Relationship'))
    map.set(attr(r, 'Id') ?? '', attr(r, 'Target') ?? '');
  return map;
}
/** `target` as a path inside the zip, relative to the folder of `from`. */
function resolvePath(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
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

export interface DocxView {
  element: HTMLElement;
  /** Release the pictures. */
  dispose(): void;
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
};

const ROMAN: Array<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];
function roman(n: number): string {
  let out = '';
  for (const [value, text] of ROMAN)
    while (n >= value) {
      out += text;
      n -= value;
    }
  return out;
}
/** 1 -> a, 26 -> z, 27 -> aa. */
function letters(n: number): string {
  let out = '';
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26))
    out = String.fromCharCode(97 + ((i - 1) % 26)) + out;
  return out;
}

function marker(format: string, n: number, level: number): string {
  switch (format) {
    case 'decimal':
      return `${n}.`;
    case 'lowerLetter':
      return `${letters(n)}.`;
    case 'upperLetter':
      return `${letters(n).toUpperCase()}.`;
    case 'lowerRoman':
      return `${roman(n)}.`;
    case 'upperRoman':
      return `${roman(n).toUpperCase()}.`;
    default:
      return ['•', '◦', '▪'][level % 3]!;
  }
}

/** A Word document as a page of paragraphs, headings, lists, tables and pictures. */
export function docxToElement(bytes: Uint8Array): DocxView {
  const zip = unzip(
    bytes,
    (n) =>
      n === 'word/document.xml' ||
      n === 'word/numbering.xml' ||
      n === 'word/_rels/document.xml.rels' ||
      n.startsWith('word/media/'),
  );
  const body = kid(xml(zip, 'word/document.xml'), 'body');
  if (!body) throw new Error('This is not a Word document that can be read.');
  const rels = relations(zip, 'word/_rels/document.xml.rels');
  const urls: string[] = [];

  // Numbering: list id -> abstract list -> the format of each level.
  const numbering = xml(zip, 'word/numbering.xml');
  const abstractFormats = new Map<string, Map<string, string>>();
  for (const a of kids(numbering, 'abstractNum')) {
    const levels = new Map<string, string>();
    for (const l of kids(a, 'lvl'))
      levels.set(attr(l, 'ilvl') ?? '0', attr(kid(l, 'numFmt'), 'val') ?? 'bullet');
    abstractFormats.set(attr(a, 'abstractNumId') ?? '', levels);
  }
  const listFormats = new Map<string, Map<string, string>>();
  for (const n of kids(numbering, 'num'))
    listFormats.set(
      attr(n, 'numId') ?? '',
      abstractFormats.get(attr(kid(n, 'abstractNumId'), 'val') ?? '') ?? new Map(),
    );
  const counters = new Map<string, number[]>();

  const picture = (drawing: Element): HTMLElement | undefined => {
    const blip = all(drawing, 'blip')[0];
    const id = attr(blip, 'embed');
    const target = id ? rels.get(id) : undefined;
    if (!target) return undefined;
    const path = resolvePath('word/document.xml', target);
    const data = zip[path];
    const type = MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
    if (!data || !type) return undefined;
    const img = document.createElement('img');
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
    urls.push(url);
    img.src = url;
    const width = Number(attr(all(drawing, 'extent')[0], 'cx'));
    if (Number.isFinite(width) && width > 0) img.style.width = `${Math.round(width / 9525)}px`;
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.alt = '';
    return img;
  };

  const run = (r: Element, into: HTMLElement): void => {
    const props = kid(r, 'rPr');
    const flag = (name: string) => {
      const el = kid(props, name);
      return el !== undefined && !['0', 'false', 'none'].includes(attr(el, 'val') ?? '1');
    };
    const raise = attr(kid(props, 'vertAlign'), 'val');
    const wrap = document.createElement(
      raise === 'superscript' ? 'sup' : raise === 'subscript' ? 'sub' : 'span',
    );
    if (flag('b')) wrap.style.fontWeight = '600';
    if (flag('i')) wrap.style.fontStyle = 'italic';
    const lines = [flag('u') && 'underline', flag('strike') && 'line-through'].filter(Boolean);
    if (lines.length > 0) wrap.style.textDecoration = lines.join(' ');
    const color = attr(kid(props, 'color'), 'val');
    if (color && /^[0-9a-f]{6}$/i.test(color)) wrap.style.color = `#${color}`;
    for (const c of r.children) {
      switch (c.localName) {
        case 't':
          wrap.append(c.textContent ?? '');
          break;
        case 'tab':
          wrap.append('\t');
          break;
        case 'br':
        case 'cr':
          wrap.append(document.createElement('br'));
          break;
        case 'noBreakHyphen':
          wrap.append('-');
          break;
        case 'drawing': {
          const img = picture(c);
          if (img) wrap.append(img);
          break;
        }
      }
    }
    into.append(wrap);
  };

  const WRAPPERS = ['hyperlink', 'smartTag', 'ins', 'sdt', 'sdtContent', 'fldSimple'];
  const runs = (parent: Element, into: HTMLElement): void => {
    for (const c of parent.children) {
      if (c.localName === 'r') run(c, into);
      else if (WRAPPERS.includes(c.localName)) {
        const inner = document.createElement('span');
        // Links are shown, not followed: a document must not send anyone anywhere.
        if (c.localName === 'hyperlink')
          inner.style.cssText = 'color:#0f6cbd;text-decoration:underline';
        runs(c, inner);
        into.append(inner);
      }
    }
  };

  const paragraph = (p: Element): HTMLElement => {
    const props = kid(p, 'pPr');
    const styleId = attr(kid(props, 'pStyle'), 'val') ?? '';
    const heading = /^heading\s?([1-6])$/i.exec(styleId);
    const el = document.createElement(heading ? (`h${heading[1]}` as 'h1') : 'p');
    if (styleId.toLowerCase() === 'title') el.className = 'doc-title';
    const align = attr(kid(props, 'jc'), 'val');
    if (align === 'center' || align === 'right') el.style.textAlign = align;
    else if (align === 'both') el.style.textAlign = 'justify';

    const num = kid(props, 'numPr');
    const numId = attr(kid(num, 'numId'), 'val');
    if (num && numId && numId !== '0') {
      const level = Number(attr(kid(num, 'ilvl'), 'val') ?? '0');
      const counts = counters.get(numId) ?? [];
      counts[level] = (counts[level] ?? 0) + 1;
      counts.length = level + 1;
      counters.set(numId, counts);
      const format = listFormats.get(numId)?.get(String(level)) ?? 'bullet';
      const tag = document.createElement('span');
      tag.className = 'doc-marker';
      tag.textContent = marker(format, counts[level]!, level);
      tag.style.left = `${24 * level}px`;
      el.style.paddingLeft = `${24 * (level + 1)}px`;
      el.style.position = 'relative';
      el.append(tag);
    }
    runs(p, el);
    if (!el.textContent && !el.querySelector('img')) el.append(document.createElement('br'));
    return el;
  };

  const table = (t: Element): HTMLElement => {
    const el = document.createElement('table');
    for (const tr of kids(t, 'tr')) {
      const row = el.insertRow();
      for (const tc of kids(tr, 'tc')) {
        const cell = row.insertCell();
        const span = Number(attr(kid(kid(tc, 'tcPr'), 'gridSpan'), 'val') ?? '1');
        if (span > 1) cell.colSpan = span;
        cell.append(...blocks(tc));
      }
    }
    return el;
  };

  const blocks = (parent: Element): HTMLElement[] =>
    kids(parent).flatMap((c) =>
      c.localName === 'p' ? [paragraph(c)] : c.localName === 'tbl' ? [table(c)] : [],
    );

  const page = document.createElement('div');
  page.className = 'doc-page';
  page.append(...blocks(body));
  return { element: page, dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
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

/** The sheets of an Excel file as grids of text (dates and number formats applied). */
export function xlsxSheets(bytes: Uint8Array, onlyFirst = false): Sheet[] {
  const zip = unzip(
    bytes,
    (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      n === 'xl/styles.xml' ||
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

  const sheets: Sheet[] = [];
  for (const s of all(kid(workbook, 'sheets'), 'sheet')) {
    if (['hidden', 'veryHidden'].includes(attr(s, 'state') ?? '')) continue;
    const target = rels.get(attr(s, 'id', true) ?? '');
    const root = target ? xml(zip, resolvePath('xl/workbook.xml', target)) : undefined;
    const rows: string[][] = [];
    let truncated = false;
    let rowNumber = 0;
    for (const row of kids(kid(root, 'sheetData'), 'row')) {
      rowNumber = Number(attr(row, 'r') ?? rowNumber + 1);
      if (rowNumber > MAX_ROWS) {
        truncated = true;
        break;
      }
      const cells: string[] = (rows[rowNumber - 1] = []);
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
        col++;
      }
    }
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    sheets.push({ name: attr(s, 'name') ?? `Sheet ${sheets.length + 1}`, rows, truncated });
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

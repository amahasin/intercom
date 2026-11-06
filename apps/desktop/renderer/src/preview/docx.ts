/**
 * A Word document drawn from its file: its styles (fonts, sizes, colours, spacing, headings), lists,
 * tables with their borders and shading, pictures, headers and footers, and the page it is set on.
 * Everything is built as DOM nodes with `textContent`, so nothing from a file is ever parsed as
 * HTML; links are drawn, never followed.
 */
import { THEME_ORDER, isHex, tinted } from './color.ts';
import {
  all,
  attr,
  kid,
  kids,
  letters,
  relations,
  resolvePath,
  themePalette,
  unzip,
  xml,
  type Zip,
} from './office.ts';

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

/** Twentieths of a point (Word's unit) as pixels. */
const px = (twips: number): number => Math.round((twips / 15) * 100) / 100;

interface TextProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  color?: string;
  /** Points. */
  size?: number;
  font?: string;
  highlight?: string;
  raise?: 'sup' | 'sub';
}

interface ParaProps {
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Pixels. */
  before?: number;
  after?: number;
  /** A multiple of the font size, or pixels when `lineExact`. */
  line?: number;
  lineExact?: boolean;
  left?: number;
  right?: number;
  hanging?: number;
  first?: number;
  fill?: string;
  borderBottom?: string;
}

interface Style {
  id: string;
  type: string;
  name: string;
  basedOn?: string;
  para: ParaProps;
  text: TextProps;
  /** A table style's borders. */
  borders?: Borders;
}

type Borders = Partial<Record<'top' | 'right' | 'bottom' | 'left' | 'insideH' | 'insideV', string>>;

const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
  black: '#000000',
};

const merge = <T extends object>(...parts: Array<T | undefined>): T =>
  Object.assign(
    {},
    ...parts.map((p) =>
      p ? Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) : {},
    ),
  ) as T;

export function docxToElement(bytes: Uint8Array): DocxView {
  const zip = unzip(
    bytes,
    (n) =>
      n === 'word/document.xml' ||
      n === 'word/numbering.xml' ||
      n === 'word/styles.xml' ||
      n === 'word/theme/theme1.xml' ||
      n === 'word/_rels/document.xml.rels' ||
      /^word\/(header|footer)\d*\.xml$/.test(n) ||
      n.startsWith('word/media/'),
  );
  const body = kid(xml(zip, 'word/document.xml'), 'body');
  if (!body) throw new Error('This is not a Word document that can be read.');
  const rels = relations(zip, 'word/_rels/document.xml.rels');
  const urls: string[] = [];
  const theme = themePalette(zip, 'word/theme/theme1.xml');
  const fontScheme = all(xml(zip, 'word/theme/theme1.xml'), 'fontScheme')[0];
  const themeFont = (kind: string) => attr(kid(kid(fontScheme, kind), 'latin'), 'typeface');
  const hasStyles = zip['word/styles.xml'] !== undefined;

  // ------------------------------------------------------------------------------------------
  // Properties

  const colour = (el: Element | undefined, name = 'val'): string | undefined => {
    if (!el) return undefined;
    const value = attr(el, name);
    const slot = attr(el, 'themeColor');
    let base: string | undefined;
    if (slot) {
      const name =
        { text1: 'dk1', text2: 'dk2', background1: 'lt1', background2: 'lt2' }[slot] ?? slot;
      base = theme[name] ?? theme[THEME_ORDER[0]!];
      const shade = attr(el, 'themeShade');
      const tint = attr(el, 'themeTint');
      if (base && shade) base = tinted(base, -(1 - parseInt(shade, 16) / 255));
      if (base && tint) base = tinted(base, 1 - parseInt(tint, 16) / 255);
    } else if (isHex(value)) base = value;
    return isHex(base) ? `#${base}` : undefined;
  };

  const flag = (props: Element | undefined, name: string): boolean | undefined => {
    const el = kid(props, name);
    if (!el) return undefined;
    return !['0', 'false', 'none'].includes(attr(el, 'val') ?? '1');
  };

  const textProps = (rPr: Element | undefined): TextProps => {
    if (!rPr) return {};
    const out: TextProps = {};
    const set = <K extends keyof TextProps>(key: K, value: TextProps[K] | undefined) => {
      if (value !== undefined) out[key] = value;
    };
    set('bold', flag(rPr, 'b'));
    set('italic', flag(rPr, 'i'));
    set('strike', flag(rPr, 'strike'));
    set('caps', flag(rPr, 'caps'));
    set('smallCaps', flag(rPr, 'smallCaps'));
    const u = kid(rPr, 'u');
    if (u) set('underline', attr(u, 'val') !== 'none');
    set('color', colour(kid(rPr, 'color')));
    const half = Number(attr(kid(rPr, 'sz'), 'val'));
    if (half > 0) set('size', half / 2);
    const fonts = kid(rPr, 'rFonts');
    const themed = attr(fonts, 'asciiTheme');
    set(
      'font',
      attr(fonts, 'ascii') ??
        (themed ? themeFont(themed.startsWith('major') ? 'majorFont' : 'minorFont') : undefined),
    );
    const marker = attr(kid(rPr, 'highlight'), 'val');
    if (marker) set('highlight', HIGHLIGHTS[marker]);
    const raise = attr(kid(rPr, 'vertAlign'), 'val');
    if (raise === 'superscript') out.raise = 'sup';
    if (raise === 'subscript') out.raise = 'sub';
    return out;
  };

  const border = (el: Element | undefined): string | undefined => {
    const style = attr(el, 'val');
    if (!el || !style || style === 'nil' || style === 'none') return undefined;
    const width = Math.max(1, Math.round(Number(attr(el, 'sz') ?? '4') / 6));
    const line =
      style === 'dotted'
        ? 'dotted'
        : style.includes('ash')
          ? 'dashed'
          : style === 'double'
            ? 'double'
            : 'solid';
    return `${line === 'double' ? width * 3 : width}px ${line} ${colour(el, 'color') ?? '#000000'}`;
  };

  const bordersOf = (el: Element | undefined): Borders => {
    const out: Borders = {};
    for (const [word, key] of [
      ['top', 'top'],
      ['left', 'left'],
      ['start', 'left'],
      ['bottom', 'bottom'],
      ['right', 'right'],
      ['end', 'right'],
      ['insideH', 'insideH'],
      ['insideV', 'insideV'],
    ] as const) {
      const b = border(kid(el, word));
      if (b) out[key] = b;
    }
    return out;
  };

  const paraProps = (pPr: Element | undefined): ParaProps => {
    if (!pPr) return {};
    const out: ParaProps = {};
    const jc = attr(kid(pPr, 'jc'), 'val');
    if (jc === 'center') out.align = 'center';
    else if (jc === 'right' || jc === 'end') out.align = 'right';
    else if (jc === 'both' || jc === 'distribute') out.align = 'justify';
    else if (jc === 'left' || jc === 'start') out.align = 'left';
    const spacing = kid(pPr, 'spacing');
    const before = attr(spacing, 'before');
    const after = attr(spacing, 'after');
    if (before !== undefined) out.before = px(Number(before));
    if (after !== undefined) out.after = px(Number(after));
    const line = Number(attr(spacing, 'line'));
    if (line > 0) {
      if ((attr(spacing, 'lineRule') ?? 'auto') === 'auto') out.line = line / 240;
      else {
        out.line = px(line);
        out.lineExact = true;
      }
    }
    const ind = kid(pPr, 'ind');
    const left = attr(ind, 'left') ?? attr(ind, 'start');
    const right = attr(ind, 'right') ?? attr(ind, 'end');
    if (left !== undefined) out.left = px(Number(left));
    if (right !== undefined) out.right = px(Number(right));
    const hanging = attr(ind, 'hanging');
    const first = attr(ind, 'firstLine');
    if (hanging !== undefined) out.hanging = px(Number(hanging));
    if (first !== undefined) out.first = px(Number(first));
    const fill = attr(kid(pPr, 'shd'), 'fill');
    if (isHex(fill)) out.fill = `#${fill}`;
    const bottom = border(kid(kid(pPr, 'pBdr'), 'bottom'));
    if (bottom) out.borderBottom = bottom;
    return out;
  };

  // ------------------------------------------------------------------------------------------
  // Styles: what a paragraph, a run or a table inherits by name

  const styles = new Map<string, Style>();
  const stylesRoot = xml(zip, 'word/styles.xml');
  const defaults = kid(stylesRoot, 'docDefaults');
  const defaultText = textProps(kid(kid(defaults, 'rPrDefault'), 'rPr'));
  const defaultPara = paraProps(kid(kid(defaults, 'pPrDefault'), 'pPr'));
  let normalId = '';
  for (const st of kids(stylesRoot, 'style')) {
    const id = attr(st, 'styleId') ?? '';
    if (attr(st, 'type') === 'paragraph' && attr(st, 'default') === '1') normalId = id;
    const tblPr = kid(st, 'tblPr');
    styles.set(id, {
      id,
      type: attr(st, 'type') ?? 'paragraph',
      name: attr(kid(st, 'name'), 'val') ?? id,
      ...(attr(kid(st, 'basedOn'), 'val') && { basedOn: attr(kid(st, 'basedOn'), 'val')! }),
      para: paraProps(kid(st, 'pPr')),
      text: textProps(kid(st, 'rPr')),
      ...(tblPr && { borders: bordersOf(kid(tblPr, 'tblBorders')) }),
    });
  }
  /** A style with everything it is based on, oldest first. */
  const chain = (id: string | undefined): Style[] => {
    const out: Style[] = [];
    const seen = new Set<string>();
    for (let at = id; at && !seen.has(at);) {
      seen.add(at);
      const st = styles.get(at);
      if (!st) break;
      out.unshift(st);
      at = st.basedOn;
    }
    return out;
  };

  // ------------------------------------------------------------------------------------------
  // Lists

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

  // ------------------------------------------------------------------------------------------
  // Runs and paragraphs

  const picture = (
    drawing: Element,
    part: Zip,
    relationships: Map<string, string>,
    from: string,
  ): HTMLElement | undefined => {
    const blip = all(drawing, 'blip')[0];
    const id = attr(blip, 'embed');
    const target = id ? relationships.get(id) : undefined;
    if (!target) return undefined;
    const path = resolvePath(from, target);
    const data = part[path];
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

  const applyText = (node: HTMLElement, look: TextProps): void => {
    if (look.bold) node.style.fontWeight = '700';
    if (look.italic) node.style.fontStyle = 'italic';
    const lines = [look.underline && 'underline', look.strike && 'line-through'].filter(Boolean);
    if (lines.length > 0) node.style.textDecoration = lines.join(' ');
    if (look.caps) node.style.textTransform = 'uppercase';
    if (look.smallCaps) node.style.fontVariant = 'small-caps';
    if (look.color) node.style.color = look.color;
    if (look.size) node.style.fontSize = `${look.size}pt`;
    if (look.font) node.style.fontFamily = `"${look.font}", Calibri, "Segoe UI", sans-serif`;
    if (look.highlight) node.style.background = look.highlight;
  };

  const run = (
    r: Element,
    into: HTMLElement,
    inherited: TextProps,
    source: Zip,
    relationships: Map<string, string>,
    from: string,
  ): void => {
    const props = kid(r, 'rPr');
    const own = merge(
      ...chain(attr(kid(props, 'rStyle'), 'val')).map((s) => s.text),
      textProps(props),
    );
    const look = merge(inherited, own);
    const wrap = document.createElement(
      look.raise === 'sup' ? 'sup' : look.raise === 'sub' ? 'sub' : 'span',
    );
    applyText(wrap, look);
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
          const img = picture(c, source, relationships, from);
          if (img) wrap.append(img);
          break;
        }
      }
    }
    into.append(wrap);
  };

  const WRAPPERS = ['hyperlink', 'smartTag', 'ins', 'sdt', 'sdtContent', 'fldSimple'];
  const runs = (
    parent: Element,
    into: HTMLElement,
    inherited: TextProps,
    source: Zip,
    relationships: Map<string, string>,
    from: string,
  ): void => {
    for (const c of parent.children) {
      if (c.localName === 'r') run(c, into, inherited, source, relationships, from);
      else if (WRAPPERS.includes(c.localName)) {
        const inner = document.createElement('span');
        // Links are shown, not followed: a document must not send anyone anywhere.
        if (c.localName === 'hyperlink')
          inner.style.cssText = 'color:#0f6cbd;text-decoration:underline';
        runs(c, inner, inherited, source, relationships, from);
        into.append(inner);
      }
    }
  };

  const paragraph = (
    p: Element,
    source: Zip,
    relationships: Map<string, string>,
    from: string,
    inTable = false,
  ): HTMLElement => {
    const props = kid(p, 'pPr');
    const styleId = attr(kid(props, 'pStyle'), 'val') ?? (hasStyles ? normalId : '');
    const styleChain = chain(styleId);
    const named = styleChain.at(-1)?.name ?? styleId;
    const heading = /^heading\s?([1-6])$/i.exec(named) ?? /^heading\s?([1-6])$/i.exec(styleId);
    const el = document.createElement(heading ? (`h${heading[1]}` as 'h1') : 'p');
    if (/^title$/i.test(named) || styleId.toLowerCase() === 'title') el.className = 'doc-title';

    const para = merge(defaultPara, ...styleChain.map((s) => s.para), paraProps(props));
    const text = merge(defaultText, ...styleChain.map((s) => s.text));
    if (para.align) el.style.textAlign = para.align;
    if (para.before !== undefined) el.style.marginTop = `${para.before}px`;
    if (para.after !== undefined) el.style.marginBottom = `${para.after}px`;
    if (inTable && para.after === undefined) el.style.marginBottom = '0';
    if (para.line) el.style.lineHeight = para.lineExact ? `${para.line}px` : String(para.line);
    if (para.right) el.style.marginRight = `${para.right}px`;
    if (para.fill) el.style.background = para.fill;
    if (para.borderBottom) el.style.borderBottom = para.borderBottom;
    let left = para.left ?? 0;
    const indent = para.hanging ? -para.hanging : (para.first ?? 0);

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
      left = Math.max(left, 24 * (level + 1));
      el.style.position = 'relative';
      el.append(tag);
    }
    if (left) el.style.paddingLeft = `${left}px`;
    if (indent && !(num && numId && numId !== '0')) el.style.textIndent = `${indent}px`;
    // Text the paragraph's own style sets (a heading's size and colour) is the base of its runs.
    applyText(el, text);
    runs(p, el, {}, source, relationships, from);
    if (!el.textContent && !el.querySelector('img')) el.append(document.createElement('br'));
    return el;
  };

  // ------------------------------------------------------------------------------------------
  // Tables

  const table = (
    t: Element,
    source: Zip,
    relationships: Map<string, string>,
    from: string,
  ): HTMLElement => {
    const el = document.createElement('table');
    const props = kid(t, 'tblPr');
    const styleBorders = merge<Borders>(
      ...chain(attr(kid(props, 'tblStyle'), 'val')).map((s) => s.borders),
    );
    const direct = bordersOf(kid(props, 'tblBorders'));
    const borders: Borders = merge(styleBorders, direct);
    const fallback = !hasStyles && Object.keys(borders).length === 0;
    const width = kid(props, 'tblW');
    if (attr(width, 'type') === 'dxa' && Number(attr(width, 'w')) > 0)
      el.style.width = `${px(Number(attr(width, 'w')))}px`;
    else if (attr(width, 'type') === 'pct' && Number(attr(width, 'w')) > 0)
      el.style.width = `${Number(attr(width, 'w')) / 50}%`;
    const jc = attr(kid(props, 'jc'), 'val');
    if (jc === 'center') el.style.margin = '8px auto';
    const grid = kids(kid(t, 'tblGrid'), 'gridCol').map((g) => px(Number(attr(g, 'w'))));
    if (grid.length > 0 && grid.every((w) => w > 0)) {
      const colgroup = document.createElement('colgroup');
      for (const w of grid) {
        const col = document.createElement('col');
        col.style.width = `${w}px`;
        colgroup.append(col);
      }
      el.append(colgroup);
      el.style.tableLayout = 'fixed';
      if (!el.style.width) el.style.width = `${grid.reduce((a, b) => a + b, 0)}px`;
    }

    const rows = kids(t, 'tr');
    // A cell that continues one above (vMerge) is not drawn; the one that starts it spans down.
    const open = new Map<number, HTMLTableCellElement>();
    rows.forEach((tr, r) => {
      const row = el.insertRow();
      let column = 0;
      for (const tc of kids(tr, 'tc')) {
        const tcPr = kid(tc, 'tcPr');
        const span = Number(attr(kid(tcPr, 'gridSpan'), 'val') ?? '1');
        const merge_ = kid(tcPr, 'vMerge');
        if (merge_ && attr(merge_, 'val') !== 'restart') {
          const above = open.get(column);
          if (above) above.rowSpan += 1;
          column += span;
          continue;
        }
        const cell = row.insertCell();
        if (merge_) open.set(column, cell);
        else open.delete(column);
        if (span > 1) cell.colSpan = span;
        const cellWidth = kid(tcPr, 'tcW');
        if (!grid.length && attr(cellWidth, 'type') === 'dxa')
          cell.style.width = `${px(Number(attr(cellWidth, 'w')))}px`;
        const fill = attr(kid(tcPr, 'shd'), 'fill');
        if (isHex(fill)) cell.style.background = `#${fill}`;
        const own = bordersOf(kid(tcPr, 'tcBorders'));
        const last = column + span >= grid.length && grid.length > 0;
        const side = {
          top: own.top ?? (r === 0 ? borders.top : borders.insideH),
          bottom: own.bottom ?? (r === rows.length - 1 ? borders.bottom : borders.insideH),
          left: own.left ?? (column === 0 ? borders.left : borders.insideV),
          right: own.right ?? (last ? borders.right : borders.insideV),
        };
        if (fallback) cell.style.border = '1px solid #c8c8c8';
        if (side.top) cell.style.borderTop = side.top;
        if (side.bottom) cell.style.borderBottom = side.bottom;
        if (side.left) cell.style.borderLeft = side.left;
        if (side.right) cell.style.borderRight = side.right;
        const vAlign = attr(kid(tcPr, 'vAlign'), 'val');
        if (vAlign === 'center') cell.style.verticalAlign = 'middle';
        else if (vAlign === 'bottom') cell.style.verticalAlign = 'bottom';
        cell.append(...blocks(tc, source, relationships, from, true));
        column += span;
      }
    });
    return el;
  };

  const blocks = (
    parent: Element,
    source: Zip,
    relationships: Map<string, string>,
    from: string,
    inTable = false,
  ): HTMLElement[] =>
    kids(parent).flatMap((c) =>
      c.localName === 'p'
        ? [paragraph(c, source, relationships, from, inTable)]
        : c.localName === 'tbl'
          ? [table(c, source, relationships, from)]
          : c.localName === 'sdt'
            ? blocks(kid(c, 'sdtContent') ?? c, source, relationships, from, inTable)
            : [],
    );

  // ------------------------------------------------------------------------------------------
  // The page: its size and margins, with the header and the footer

  const section = kid(body, 'sectPr');
  const size = kid(section, 'pgSz');
  const margins = kid(section, 'pgMar');
  const page = document.createElement('div');
  page.className = 'doc-page';
  const pageWidth = px(Number(attr(size, 'w')));
  if (pageWidth > 0) page.style.width = `min(${pageWidth}px, calc(100% - 48px))`;
  if (margins) {
    const side = (name: string, fallback: string) => {
      const v = Number(attr(margins, name));
      return v > 0 ? `${px(v)}px` : fallback;
    };
    page.style.padding = `${side('top', '56px')} ${side('right', '72px')} ${side('bottom', '56px')} ${side('left', '72px')}`;
  }
  const part = (type: 'header' | 'footer'): HTMLElement | undefined => {
    const ref = kids(section, `${type}Reference`).find(
      (r) => (attr(r, 'type') ?? 'default') === 'default',
    );
    const target = ref ? rels.get(attr(ref, 'id', true) ?? '') : undefined;
    const path = target ? resolvePath('word/document.xml', target) : undefined;
    const root = path ? xml(zip, path) : undefined;
    if (!root || !path) return undefined;
    const holder = document.createElement('div');
    holder.className = `doc-${type}`;
    holder.append(...blocks(root, zip, new Map(), path));
    return holder.textContent?.trim() ? holder : undefined;
  };
  const header = part('header');
  if (header) page.append(header);
  page.append(...blocks(body, zip, rels, 'word/document.xml'));
  const footer = part('footer');
  if (footer) page.append(footer);
  return { element: page, dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

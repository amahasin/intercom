/**
 * PowerPoint slides drawn from the file: every box, picture, table and shape where the file puts
 * it, with its text as the file styles it (the slide, its layout, its master and the theme each
 * add to it). What cannot be drawn (charts, SmartArt, effects, animations) is left as a labelled
 * box or left out. Everything is built as DOM nodes with \`textContent\` (nothing from a file is
 * parsed as HTML), and sizes use container units, so a slide scales with the width it is shown at.
 */
import { SCHEME_ALIASES, isHex, lightness, tinted } from './color.ts';
import {
  all,
  attr,
  kid,
  kids,
  relations,
  resolvePath,
  themePalette,
  unzip,
  xml,
  type Zip,
} from './office.ts';

export interface SlideDeck {
  count: number;
  /** Width / height of a slide. */
  ratio: number;
  /** Slide `n` (from 0) drawn as a page; `dispose` releases its pictures. */
  draw(n: number): { element: HTMLElement; dispose(): void };
}

const MEDIA: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** What one level of a text body says about its paragraphs and runs. */
interface Level {
  algn?: string;
  /** EMU. */
  marL?: number;
  indent?: number;
  bullet?: string | 'none' | { auto: string };
  /** Points, bold, italic... */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  font?: string;
  baseline?: number;
  /** Space before and after: points, or a fraction of the font size. */
  before?: { pts: number } | { pct: number };
  after?: { pts: number } | { pct: number };
  line?: { pts: number } | { pct: number };
}

const merge = (...levels: Array<Level | undefined>): Level => {
  const out: Level = {};
  for (const level of levels)
    if (level)
      for (const [k, v] of Object.entries(level))
        if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
};

interface Ctx {
  zip: Zip;
  theme: Record<string, string>;
  major: string | undefined;
  minor: string | undefined;
  /** The master's colour map: bg1 -> lt1... */
  map: Record<string, string>;
  /** Slide size in EMU. */
  w: number;
  h: number;
  urls: string[];
  defaults: Element | undefined;
  /** The master's `p:txStyles`: title, body and other text. */
  txStyles?: Element | undefined;
}

/** The two things a placeholder is found by in a layout and a master. */
interface Placeholder {
  type: string;
  idx: string | undefined;
}

const placeholderOf = (shape: Element): Placeholder | undefined => {
  const ph = all(
    kid(shape, 'nvSpPr') ?? kid(shape, 'nvPicPr') ?? kid(shape, 'nvGraphicFramePr'),
    'ph',
  )[0];
  return ph ? { type: attr(ph, 'type') ?? 'body', idx: attr(ph, 'idx') } : undefined;
};

/** A master only has a title and a body; every other kind of placeholder follows one of them. */
const masterKind = (type: string): 'title' | 'body' | 'other' =>
  type === 'title' || type === 'ctrTitle'
    ? 'title'
    : ['sldNum', 'dt', 'ftr'].includes(type)
      ? 'other'
      : 'body';

function colorOf(holder: Element | undefined, c: Ctx, phColor?: string): string | undefined {
  const el = kids(holder).find((k) =>
    ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr'].includes(k.localName),
  );
  if (!el) return undefined;
  let hex: string | undefined;
  if (el.localName === 'srgbClr') hex = attr(el, 'val');
  else if (el.localName === 'sysClr')
    hex = attr(el, 'lastClr') ?? (attr(el, 'val') === 'window' ? 'FFFFFF' : '000000');
  else if (el.localName === 'prstClr') hex = attr(el, 'val') === 'white' ? 'FFFFFF' : '000000';
  else if (el.localName === 'schemeClr') {
    const named = attr(el, 'val') ?? '';
    if (named === 'phClr') hex = phColor;
    else {
      const mapped = c.map[named] ?? named;
      hex = c.theme[SCHEME_ALIASES[mapped] ?? mapped];
    }
  }
  if (!isHex(hex)) return undefined;
  let out = hex.toUpperCase();
  const value = (name: string) => {
    const v = attr(kid(el, name), 'val');
    return v === undefined ? undefined : Number(v) / 100_000;
  };
  const mod = value('lumMod');
  const off = value('lumOff');
  if (mod !== undefined || off !== undefined) out = lightness(out, mod ?? 1, off ?? 0);
  const tint = value('tint');
  if (tint !== undefined) out = tinted(out, 1 - tint);
  const shade = value('shade');
  if (shade !== undefined) out = tinted(out, -(1 - shade));
  return `#${out}`;
}

/** A fill of a shape: a colour, a gradient (as CSS) or nothing. `undefined`: it does not say. */
function fillOf(sp: Element | undefined, c: Ctx, phColor?: string): string | null | undefined {
  if (!sp) return undefined;
  if (kid(sp, 'noFill')) return null;
  const solid = kid(sp, 'solidFill');
  if (solid) return colorOf(solid, c, phColor) ?? null;
  const gradient = kid(sp, 'gradFill');
  if (gradient) {
    const stops = all(kid(gradient, 'gsLst'), 'gs')
      .map((gs) => {
        const color = colorOf(gs, c, phColor);
        return color ? `${color} ${Number(attr(gs, 'pos') ?? '0') / 1000}%` : undefined;
      })
      .filter(Boolean);
    if (stops.length === 0) return undefined;
    const angle = Number(attr(kid(gradient, 'lin'), 'ang') ?? '5400000') / 60_000;
    return `linear-gradient(${angle + 90}deg, ${stops.join(', ')})`;
  }
  return undefined;
}

/** One level's paragraph and run properties from a \`lvlNpPr\`, \`pPr\` or \`defRPr\`-bearing element. */
function levelOf(el: Element | undefined, c: Ctx, phColor?: string): Level {
  if (!el) return {};
  const level: Level = {};
  const algn = attr(el, 'algn');
  if (algn) level.algn = algn;
  const marL = attr(el, 'marL');
  if (marL !== undefined) level.marL = Number(marL);
  const indent = attr(el, 'indent');
  if (indent !== undefined) level.indent = Number(indent);
  if (kid(el, 'buNone')) level.bullet = 'none';
  const char = attr(kid(el, 'buChar'), 'char');
  if (char) level.bullet = char;
  const auto = attr(kid(el, 'buAutoNum'), 'type');
  if (auto) level.bullet = { auto };
  const spacing = (name: string): Level['before'] => {
    const holder = kid(el, name);
    const pct = attr(kid(holder, 'spcPct'), 'val');
    const pts = attr(kid(holder, 'spcPts'), 'val');
    return pct !== undefined
      ? { pct: Number(pct) / 100_000 }
      : pts !== undefined
        ? { pts: Number(pts) / 100 }
        : undefined;
  };
  const before = spacing('spcBef');
  const after = spacing('spcAft');
  const line = spacing('lnSpc');
  if (before) level.before = before;
  if (after) level.after = after;
  if (line) level.line = line;
  // The run properties: the paragraph's \`defRPr\`, or the element itself for a run (\`rPr\`).
  const run = el.localName === 'rPr' || el.localName === 'endParaRPr' ? el : kid(el, 'defRPr');
  if (run) {
    const size = attr(run, 'sz');
    if (size !== undefined) level.size = Number(size) / 100;
    if (attr(run, 'b') !== undefined)
      level.bold = attr(run, 'b') === '1' || attr(run, 'b') === 'true';
    if (attr(run, 'i') !== undefined)
      level.italic = attr(run, 'i') === '1' || attr(run, 'i') === 'true';
    const u = attr(run, 'u');
    if (u !== undefined) level.underline = u !== 'none';
    const strike = attr(run, 'strike');
    if (strike !== undefined) level.strike = strike !== 'noStrike';
    const baseline = attr(run, 'baseline');
    if (baseline !== undefined) level.baseline = Number(baseline);
    const color = colorOf(kid(run, 'solidFill'), c, phColor);
    if (color) level.color = color;
    const face = attr(kid(run, 'latin'), 'typeface');
    if (face) level.font = face === '+mj-lt' ? c.major : face === '+mn-lt' ? c.minor : face;
  }
  return level;
}

const levelAt = (list: Element | undefined, n: number, c: Ctx, phColor?: string): Level =>
  levelOf(kid(list, `lvl${n + 1}pPr`), c, phColor);

/** EMU as a percentage of the slide's width (container units, so everything scales together). */
const cq = (emu: number, c: Ctx): string => `${((emu * 100) / c.w).toFixed(4)}cqw`;
/** A size in points as container width units. */
const pt = (points: number, c: Ctx): string => cq(points * 12_700, c);

interface Transform {
  /** child -> slide: X = ax * x + bx, Y = ay * y + by (EMU). */
  ax: number;
  bx: number;
  ay: number;
  by: number;
}
const IDENTITY: Transform = { ax: 1, bx: 0, ay: 1, by: 0 };

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

function frameOf(xfrm: Element | undefined): Frame | undefined {
  if (!xfrm) return undefined;
  const off = kid(xfrm, 'off');
  const ext = kid(xfrm, 'ext');
  if (!off || !ext) return undefined;
  return {
    x: Number(attr(off, 'x')),
    y: Number(attr(off, 'y')),
    w: Number(attr(ext, 'cx')),
    h: Number(attr(ext, 'cy')),
    rot: Number(attr(xfrm, 'rot') ?? '0') / 60_000,
    flipH: attr(xfrm, 'flipH') === '1',
    flipV: attr(xfrm, 'flipV') === '1',
  };
}

const el = (tag: string, style: Partial<CSSStyleDeclaration> | Record<string, string> = {}) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(style))
    (node.style as unknown as Record<string, string>)[k] = v as string;
  return node;
};

/** Where a part's shapes are, and how to find the ones that a slide's placeholders inherit from. */
interface Source {
  root: Element;
  /** \`p:cSld/p:spTree\`. */
  tree: Element | undefined;
}

function findPlaceholder(
  tree: Element | undefined,
  wanted: Placeholder,
  master: boolean,
): Element | undefined {
  const shapes = kids(tree).filter((k) => ['sp', 'pic', 'graphicFrame'].includes(k.localName));
  const kind = masterKind(wanted.type);
  return (
    (!master && wanted.idx !== undefined
      ? shapes.find((s) => placeholderOf(s)?.idx === wanted.idx)
      : undefined) ??
    shapes.find((s) => {
      const ph = placeholderOf(s);
      return (
        ph &&
        (master ? masterKind(ph.type) === kind && ph.type !== 'sldNum' : ph.type === wanted.type)
      );
    }) ??
    (master
      ? undefined
      : shapes.find((s) => {
          const ph = placeholderOf(s);
          return ph && masterKind(ph.type) === kind;
        }))
  );
}

interface Inherit {
  layout: Source | undefined;
  master: Source | undefined;
}

/** Everything a deck's slides draw from, parsed once. */
function load(bytes: Uint8Array): { c: Ctx; order: string[]; ratio: number } {
  const zip = unzip(bytes, (n) =>
    /^ppt\/(presentation\.xml|_rels\/|slides\/|slideLayouts\/|slideMasters\/|theme\/|media\/)/.test(
      n,
    ),
  );
  const presentation = xml(zip, 'ppt/presentation.xml');
  if (!presentation) throw new Error('This is not a PowerPoint file that can be read.');
  const rels = relations(zip, 'ppt/_rels/presentation.xml.rels');
  const size = all(presentation, 'sldSz')[0];
  const w = Number(attr(size, 'cx')) || 9_144_000;
  const h = Number(attr(size, 'cy')) || 5_143_500;
  const order = all(kid(presentation, 'sldIdLst'), 'sldId')
    .map((id) => rels.get(attr(id, 'id', true) ?? ''))
    .filter((t): t is string => t !== undefined)
    .map((t) => resolvePath('ppt/presentation.xml', t));
  const theme = themePalette(zip, 'ppt/theme/theme1.xml');
  const fonts = all(xml(zip, 'ppt/theme/theme1.xml'), 'fontScheme')[0];
  const face = (kind: string) => attr(kid(kid(fonts, kind), 'latin'), 'typeface');
  return {
    c: {
      zip,
      theme,
      major: face('majorFont'),
      minor: face('minorFont'),
      map: {},
      w,
      h,
      urls: [],
      defaults: kid(presentation, 'defaultTextStyle'),
    },
    order,
    ratio: w / h,
  };
}

/** A part (a layout or a master) with the way to its pictures. */
function part(c: Ctx, path: string | undefined): (Source & { path: string }) | undefined {
  if (!path) return undefined;
  const root = xml(c.zip, path);
  return root ? { root, tree: kid(kid(root, 'cSld'), 'spTree'), path } : undefined;
}

const relatedPart = (c: Ctx, from: string, type: RegExp): string | undefined => {
  const relPath = from.replace(/([^/]+)$/, '_rels/$1.rels');
  for (const r of all(xml(c.zip, relPath), 'Relationship'))
    if (type.test(attr(r, 'Type') ?? '')) return resolvePath(from, attr(r, 'Target') ?? '');
  return undefined;
};

/** Opens a deck: its slides are drawn one at a time, when they are wanted. */
export function openDeck(bytes: Uint8Array): SlideDeck {
  const { c, order, ratio } = load(bytes);
  return {
    count: order.length,
    ratio,
    draw(n) {
      const urls: string[] = [];
      const element = drawSlide(c, order[n]!, urls);
      return { element, dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
    },
  };
}

function drawSlide(c: Ctx, path: string, urls: string[]): HTMLElement {
  const slide = part(c, path);
  const page = el('div', {
    position: 'absolute',
    inset: '0',
    overflow: 'hidden',
    background: '#ffffff',
    color: '#000000',
  });
  if (!slide) return page;
  const layoutPath = relatedPart(c, path, /slideLayout$/);
  const layout = part(c, layoutPath);
  const masterPath = layoutPath ? relatedPart(c, layoutPath, /slideMaster$/) : undefined;
  const master = part(c, masterPath);
  // The master's colour map points the slide's colour names at the theme's.
  const clrMap: Record<string, string> = {};
  for (const a of kid(master?.root, 'clrMap')?.attributes ?? []) clrMap[a.localName] = a.value;
  const ctx: Ctx = { ...c, map: clrMap, urls, txStyles: kid(master?.root, 'txStyles') };

  // Background: the slide's own, else the layout's, else the master's.
  for (const source of [slide, layout, master]) {
    const bg = kid(kid(source?.root, 'cSld'), 'bg');
    if (!bg) continue;
    const props = kid(bg, 'bgPr');
    const fill = fillOf(props, ctx);
    const ref = kid(bg, 'bgRef');
    const picture = kid(props, 'blipFill');
    if (picture) {
      const url = mediaUrl(ctx, source!.path, attr(kid(picture, 'blip'), 'embed', true), urls);
      if (url) {
        page.style.background = `#ffffff center / cover no-repeat url("${url}")`;
        break;
      }
    }
    const refColor = ref ? colorOf(ref, ctx) : undefined;
    const chosen = fill ?? refColor;
    if (chosen) {
      page.style.background = chosen;
      break;
    }
    if (fill === null) break;
  }

  const inherit: Inherit = { layout, master };
  // Decoration on the master and the layout (a logo, a bar) sits behind the slide's own shapes.
  const showMaster = attr(slide.root, 'showMasterSp') !== '0';
  if (showMaster && layout && attr(layout.root, 'showMasterSp') !== '0' && master)
    drawTree(ctx, master, master, inherit, IDENTITY, page, true);
  if (showMaster && layout) drawTree(ctx, layout, layout, inherit, IDENTITY, page, true);
  drawTree(ctx, slide, slide, inherit, IDENTITY, page, false);
  return page;
}

function mediaUrl(
  c: Ctx,
  from: string,
  id: string | undefined,
  urls: string[],
): string | undefined {
  if (!id) return undefined;
  const target = relations(c.zip, from.replace(/([^/]+)$/, '_rels/$1.rels')).get(id);
  if (!target) return undefined;
  const path = resolvePath(from, target);
  const data = c.zip[path];
  const type = MEDIA[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
  if (!data || !type) return undefined;
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  urls.push(url);
  return url;
}

function drawTree(
  c: Ctx,
  from: Source & { path: string },
  owner: Source & { path: string },
  inherit: Inherit,
  t: Transform,
  into: HTMLElement,
  decoration: boolean,
): void {
  for (const shape of kids(from.tree ?? from.root)) {
    switch (shape.localName) {
      case 'sp':
      case 'cxnSp': {
        // On a layout or master only what is not a placeholder is drawn: the placeholders are
        // what slides inherit, and are empty prompts there.
        if (decoration && placeholderOf(shape)) continue;
        drawShape(c, shape, inherit, t, into);
        break;
      }
      case 'pic':
        if (decoration && placeholderOf(shape)) continue;
        drawPicture(c, shape, owner, inherit, t, into);
        break;
      case 'graphicFrame':
        if (decoration && placeholderOf(shape)) continue;
        drawFrame(c, shape, t, into);
        break;
      case 'grpSp': {
        const props = kid(shape, 'grpSpPr');
        const xfrm = kid(props, 'xfrm');
        const own = frameOf(xfrm);
        const childOff = kid(xfrm, 'chOff');
        const childExt = kid(xfrm, 'chExt');
        let next = t;
        if (own && childOff && childExt) {
          const sx = Number(attr(childExt, 'cx')) ? own.w / Number(attr(childExt, 'cx')) : 1;
          const sy = Number(attr(childExt, 'cy')) ? own.h / Number(attr(childExt, 'cy')) : 1;
          const ox = own.x - Number(attr(childOff, 'x')) * sx;
          const oy = own.y - Number(attr(childOff, 'y')) * sy;
          next = { ax: t.ax * sx, bx: t.ax * ox + t.bx, ay: t.ay * sy, by: t.ay * oy + t.by };
        }
        drawTree(
          c,
          { root: shape, tree: shape, path: from.path },
          owner,
          inherit,
          next,
          into,
          decoration,
        );
        break;
      }
    }
  }
}

/** Where a shape is: its own frame, or the one its placeholder has on the layout or the master. */
function frameFor(
  shape: Element,
  inherit: Inherit,
  t: Transform,
  c: Ctx,
):
  | { frame: Frame; ph: Placeholder | undefined; layoutShape?: Element; masterShape?: Element }
  | undefined {
  const spPr = kid(shape, 'spPr') ?? kid(shape, 'grpSpPr');
  const ph = placeholderOf(shape);
  const layoutShape = ph ? findPlaceholder(inherit.layout?.tree, ph, false) : undefined;
  const masterShape = ph ? findPlaceholder(inherit.master?.tree, ph, true) : undefined;
  const own =
    frameOf(kid(spPr, 'xfrm')) ??
    frameOf(kid(kid(layoutShape, 'spPr'), 'xfrm')) ??
    frameOf(kid(kid(masterShape, 'spPr'), 'xfrm')) ??
    (ph ? defaultFrame(ph, c) : undefined);
  if (!own) return undefined;
  const frame: Frame = {
    ...own,
    x: t.ax * own.x + t.bx,
    y: t.ay * own.y + t.by,
    w: own.w * t.ax,
    h: own.h * t.ay,
  };
  return { frame, ph, ...(layoutShape && { layoutShape }), ...(masterShape && { masterShape }) };
}

/** Where a title or a body goes in a file that gives no layout for it (a stripped-down one). */
function defaultFrame(ph: Placeholder, c: Ctx): Frame | undefined {
  const kind = masterKind(ph.type);
  if (kind === 'other') return undefined;
  const title = kind === 'title';
  return {
    x: c.w * 0.05,
    y: c.h * (title ? 0.05 : 0.28),
    w: c.w * 0.9,
    h: c.h * (title ? 0.2 : 0.62),
    rot: 0,
    flipH: false,
    flipV: false,
  };
}

function place(node: HTMLElement, f: Frame, c: Ctx): void {
  node.style.position = 'absolute';
  node.style.boxSizing = 'border-box';
  node.style.left = `${(f.x * 100) / c.w}%`;
  node.style.top = `${(f.y * 100) / c.h}%`;
  node.style.width = `${(f.w * 100) / c.w}%`;
  node.style.height = `${(f.h * 100) / c.h}%`;
  const turns = [
    f.rot ? `rotate(${f.rot}deg)` : '',
    f.flipH ? 'scaleX(-1)' : '',
    f.flipV ? 'scaleY(-1)' : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (turns) node.style.transform = turns;
}

const DASHES: Record<string, string> = {
  dash: 'dashed',
  sysDash: 'dashed',
  lgDash: 'dashed',
  dot: 'dotted',
  sysDot: 'dotted',
  dashDot: 'dashed',
};

interface Line {
  color: string;
  /** EMU. */
  width: number;
  dash: string;
}

/** A shape's outline: its own, else the placeholder's, else what its style names. */
function lineOf(shape: Element, chain: Array<Element | undefined>, c: Ctx): Line | null {
  for (const spPr of chain) {
    const ln = kid(spPr, 'ln');
    if (!ln) continue;
    if (kid(ln, 'noFill')) return null;
    const color = colorOf(kid(ln, 'solidFill'), c);
    const refColor = colorOf(kid(kid(shape, 'style'), 'lnRef'), c);
    const resolved = color ?? refColor;
    if (!resolved) continue;
    return {
      color: resolved,
      width: Number(attr(ln, 'w') ?? '12700'),
      dash: DASHES[attr(kid(ln, 'prstDash'), 'val') ?? ''] ?? 'solid',
    };
  }
  const ref = kid(kid(shape, 'style'), 'lnRef');
  if (ref && attr(ref, 'idx') !== '0') {
    const color = colorOf(ref, c);
    if (color) return { color, width: 12_700, dash: 'solid' };
  }
  return null;
}

function geometryStyle(preset: string, node: HTMLElement): void {
  switch (preset) {
    case 'ellipse':
      node.style.borderRadius = '50%';
      break;
    case 'roundRect':
    case 'round1Rect':
    case 'round2SameRect':
      node.style.borderRadius = '8%';
      break;
    case 'triangle':
      node.style.clipPath = 'polygon(50% 0, 100% 100%, 0 100%)';
      break;
    case 'diamond':
      node.style.clipPath = 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)';
      break;
    case 'rtTriangle':
      node.style.clipPath = 'polygon(0 0, 100% 100%, 0 100%)';
      break;
    case 'hexagon':
      node.style.clipPath = 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)';
      break;
    case 'rightArrow':
      node.style.clipPath = 'polygon(0 25%, 60% 25%, 60% 0, 100% 50%, 60% 100%, 60% 75%, 0 75%)';
      break;
    case 'leftArrow':
      node.style.clipPath = 'polygon(100% 25%, 40% 25%, 40% 0, 0 50%, 40% 100%, 40% 75%, 100% 75%)';
      break;
    case 'chevron':
      node.style.clipPath = 'polygon(0 0, 75% 0, 100% 50%, 75% 100%, 0 100%, 25% 50%)';
      break;
    case 'pentagon':
    case 'homePlate':
      node.style.clipPath = 'polygon(0 0, 75% 0, 100% 50%, 75% 100%, 0 100%)';
      break;
  }
}

/** A freeform shape as an SVG path (move, line, curves and close are drawn; arcs are not). */
function freeform(
  custom: Element,
  fill: string | null | undefined,
  line: Line | null,
  c: Ctx,
): SVGElement | undefined {
  const path = all(kid(custom, 'pathLst'), 'path')[0];
  if (!path) return undefined;
  const w = Number(attr(path, 'w')) || 1;
  const h = Number(attr(path, 'h')) || 1;
  const point = (p: Element | undefined) => `${attr(p, 'x')} ${attr(p, 'y')}`;
  let d = '';
  for (const step of kids(path)) {
    const pts = kids(step, 'pt');
    if (step.localName === 'moveTo') d += `M${point(pts[0])} `;
    else if (step.localName === 'lnTo') d += `L${point(pts[0])} `;
    else if (step.localName === 'cubicBezTo') d += `C${pts.map(point).join(' ')} `;
    else if (step.localName === 'quadBezTo') d += `Q${pts.map(point).join(' ')} `;
    else if (step.localName === 'close') d += 'Z ';
  }
  if (!d) return undefined;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible';
  const shape = document.createElementNS(ns, 'path');
  shape.setAttribute('d', d);
  shape.setAttribute('fill', fill && !fill.startsWith('linear') ? fill : 'none');
  if (line) {
    shape.setAttribute('stroke', line.color);
    shape.setAttribute('stroke-width', String(line.width));
    shape.setAttribute('vector-effect', 'non-scaling-stroke');
    shape.style.strokeWidth = `${(line.width * 100) / c.w}cqw`;
  }
  svg.append(shape);
  return svg;
}

function drawShape(
  c: Ctx,
  shape: Element,
  inherit: Inherit,
  t: Transform,
  into: HTMLElement,
): void {
  const found = frameFor(shape, inherit, t, c);
  if (!found) return;
  const { frame, ph, layoutShape, masterShape } = found;
  const spPr = kid(shape, 'spPr');
  const chain = [spPr, kid(layoutShape, 'spPr'), kid(masterShape, 'spPr')];
  const style = kid(shape, 'style');
  const fillRef = kid(style, 'fillRef');
  const fillRefColor = fillRef && attr(fillRef, 'idx') !== '0' ? colorOf(fillRef, c) : undefined;

  let fill: string | null | undefined;
  for (const props of chain) {
    fill = fillOf(props, c);
    if (fill !== undefined) break;
  }
  fill ??= fillRefColor;
  const line = lineOf(shape, chain, c);
  const connector = shape.localName === 'cxnSp';
  const preset =
    attr(kid(spPr, 'prstGeom'), 'prst') ??
    attr(kid(kid(layoutShape, 'spPr'), 'prstGeom'), 'prst') ??
    'rect';

  const box = el('div');
  place(box, frame, c);

  if (connector || preset === 'line' || preset === 'straightConnector1') {
    // A line: from one corner of its frame to the other.
    if (!line) return;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible';
    const stroke = document.createElementNS(ns, 'line');
    stroke.setAttribute('x1', '0');
    stroke.setAttribute('y1', '0');
    stroke.setAttribute('x2', '100');
    stroke.setAttribute('y2', '100');
    stroke.setAttribute('stroke', line.color);
    stroke.setAttribute('vector-effect', 'non-scaling-stroke');
    stroke.style.strokeWidth = `${Math.max(0.1, (line.width * 100) / c.w)}cqw`;
    if (line.dash !== 'solid') stroke.setAttribute('stroke-dasharray', '6 4');
    svg.append(stroke);
    box.append(svg);
    into.append(box);
    return;
  }

  const custom = kid(spPr, 'custGeom');
  if (custom) {
    const drawn = freeform(custom, fill, line, c);
    if (drawn) box.append(drawn);
  } else {
    if (fill) box.style.background = fill;
    if (
      line &&
      ![
        'triangle',
        'diamond',
        'rtTriangle',
        'hexagon',
        'rightArrow',
        'leftArrow',
        'chevron',
        'pentagon',
        'homePlate',
      ].includes(preset)
    )
      box.style.border = `${cq(Math.max(line.width, 6_000), c)} ${line.dash} ${line.color}`;
    geometryStyle(preset, box);
  }

  const body = kid(shape, 'txBody');
  if (body) {
    const text = drawText(c, body, shape, ph, layoutShape, masterShape);
    if (text) box.append(text);
  }
  into.append(box);
}

/** A text body: its paragraphs, styled by the chain of what it inherits from. */
function drawText(
  c: Ctx,
  body: Element,
  shape: Element,
  ph: Placeholder | undefined,
  layoutShape: Element | undefined,
  masterShape: Element | undefined,
): HTMLElement | undefined {
  const paragraphs = kids(body, 'p');
  if (paragraphs.every((p) => !all(p, 't').some((t) => (t.textContent ?? '') !== '')))
    return undefined;

  // The shape's own style may name a text colour (a box made in PowerPoint has a white one).
  const fontRef = kid(kid(shape, 'style'), 'fontRef');
  const styleColor = fontRef ? colorOf(fontRef, c) : undefined;

  const bodyPr = [
    kid(body, 'bodyPr'),
    kid(kid(layoutShape, 'txBody'), 'bodyPr'),
    kid(kid(masterShape, 'txBody'), 'bodyPr'),
  ];
  const bodyAttr = (name: string) => bodyPr.map((b) => attr(b, name)).find((v) => v !== undefined);
  const inset = (name: string, fallback: number) => Number(bodyAttr(name) ?? fallback);
  const anchor = bodyAttr('anchor');
  const fontScale =
    Number(
      attr(
        kid(
          bodyPr.find((b) => kid(b, 'normAutofit')),
          'normAutofit',
        ),
        'fontScale',
      ) ?? '100000',
    ) / 100_000;

  const out = el('div', {
    position: 'absolute',
    inset: '0',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start',
    padding: `${cq(inset('tIns', 45_720), c)} ${cq(inset('rIns', 91_440), c)} ${cq(inset('bIns', 45_720), c)} ${cq(inset('lIns', 91_440), c)}`,
    boxSizing: 'border-box',
    overflowWrap: 'break-word',
  });

  // What every paragraph of this body starts from, by level.
  const lists = (): Array<Element | undefined> => [
    kid(body, 'lstStyle'),
    kid(kid(layoutShape, 'txBody'), 'lstStyle'),
    kid(kid(masterShape, 'txBody'), 'lstStyle'),
  ];
  const kind = ph ? masterKind(ph.type) : undefined;
  const inherited = (n: number): Level => {
    const [own, layout, master] = lists();
    return merge(
      // Text that is not in a placeholder starts from the presentation's own default.
      kind === undefined ? levelAt(c.defaults, n, c) : undefined,
      kind === undefined && styleColor ? { color: styleColor } : undefined,
      levelAt(master, n, c),
      levelAt(layout, n, c),
      levelAt(own, n, c),
    );
  };

  const counters: number[] = [];
  let last = -1;
  for (const p of paragraphs) {
    const pPr = kid(p, 'pPr');
    const n = Math.min(8, Number(attr(pPr, 'lvl') ?? '0'));
    const base = merge(
      { size: kind === 'title' ? 36 : kind === 'body' ? 24 : 18 },
      inheritedWithMaster(c, ph, n, inherited),
      levelOf(pPr, c),
    );
    const para = el('div', {
      textAlign:
        base.algn === 'ctr'
          ? 'center'
          : base.algn === 'r'
            ? 'right'
            : base.algn === 'just'
              ? 'justify'
              : 'left',
      paddingLeft: cq(base.marL ?? 0, c),
      textIndent: cq(base.indent ?? 0, c),
      margin: '0',
    });
    const size = (base.size ?? 18) * fontScale;
    if (base.before)
      para.style.marginTop =
        'pts' in base.before ? pt(base.before.pts, c) : pt(size * base.before.pct, c);
    if (base.after)
      para.style.marginBottom =
        'pts' in base.after ? pt(base.after.pts, c) : pt(size * base.after.pct, c);
    para.style.lineHeight = base.line
      ? 'pct' in base.line
        ? String(base.line.pct * 1.2)
        : pt(base.line.pts, c)
      : '1.2';

    // The bullet or number, hanging in the indent.
    const bullet = base.bullet;
    if (bullet && bullet !== 'none') {
      if (n <= last && typeof bullet !== 'string') counters.length = n + 1;
      counters[n] = (counters[n] ?? 0) + 1;
      counters.length = n + 1;
      const mark = el('span');
      mark.textContent =
        (typeof bullet === 'string' ? bullet : numbered(bullet.auto, counters[n]!)) + ' ';
      mark.style.fontSize = pt(size, c);
      if (base.color) mark.style.color = base.color;
      para.append(mark);
    } else counters.length = 0;
    last = n;

    let any = false;
    for (const r of kids(p)) {
      if (r.localName === 'br') {
        para.append(document.createElement('br'));
        continue;
      }
      if (r.localName !== 'r' && r.localName !== 'fld') continue;
      const text = kid(r, 't')?.textContent ?? '';
      if (text === '') continue;
      any = true;
      const run = merge(base, levelOf(kid(r, 'rPr'), c));
      const span = el('span', { fontSize: pt((run.size ?? 18) * fontScale, c) });
      if (run.bold) span.style.fontWeight = '700';
      if (run.italic) span.style.fontStyle = 'italic';
      const lines = [run.underline && 'underline', run.strike && 'line-through'].filter(Boolean);
      if (lines.length > 0) span.style.textDecoration = lines.join(' ');
      if (run.color) span.style.color = run.color;
      if (run.font) span.style.fontFamily = `"${run.font}", sans-serif`;
      if (run.baseline) {
        span.style.verticalAlign = run.baseline > 0 ? 'super' : 'sub';
        span.style.fontSize = pt((run.size ?? 18) * fontScale * 0.7, c);
      }
      span.textContent = text;
      para.append(span);
    }
    if (!any) {
      // An empty line still takes the height of its text.
      const blank = el('span', { fontSize: pt(size, c) });
      blank.textContent = '​';
      para.append(blank);
    }
    out.append(para);
  }
  return out;
}

/** The master's text styles for a placeholder (title, body or other) under what the slide inherits. */
function inheritedWithMaster(
  c: Ctx,
  ph: Placeholder | undefined,
  n: number,
  inherited: (n: number) => Level,
): Level {
  const kind = ph ? masterKind(ph.type) : undefined;
  const holder =
    kind === 'title'
      ? 'titleStyle'
      : kind === 'body'
        ? 'bodyStyle'
        : kind === 'other'
          ? 'otherStyle'
          : undefined;
  const fromMaster = holder ? levelAt(kid(c.txStyles, holder), n, c) : undefined;
  return merge(fromMaster, inherited(n));
}

function numbered(type: string, n: number): string {
  const letters = (v: number): string => {
    let out = '';
    for (let i = v; i > 0; i = Math.floor((i - 1) / 26))
      out = String.fromCharCode(97 + ((i - 1) % 26)) + out;
    return out;
  };
  if (type.startsWith('alphaLc'))
    return type.endsWith('ParenBoth')
      ? `(${letters(n)})`
      : type.endsWith('ParenR')
        ? `${letters(n)})`
        : `${letters(n)}.`;
  if (type.startsWith('alphaUc'))
    return type.endsWith('ParenR')
      ? `${letters(n).toUpperCase()})`
      : `${letters(n).toUpperCase()}.`;
  return type.endsWith('ParenR') ? `${n})` : type.endsWith('ParenBoth') ? `(${n})` : `${n}.`;
}

function drawPicture(
  c: Ctx,
  shape: Element,
  owner: Source & { path: string },
  inherit: Inherit,
  t: Transform,
  into: HTMLElement,
): void {
  const found = frameFor(shape, inherit, t, c);
  if (!found) return;
  const fillEl = kid(shape, 'blipFill');
  const url = mediaUrl(c, owner.path, attr(kid(fillEl, 'blip'), 'embed', true), c.urls);
  const box = el('div', { overflow: 'hidden' });
  place(box, found.frame, c);
  if (!url) {
    // A picture this view cannot draw (a Windows metafile, say): a quiet box in its place.
    box.style.background = '#f0f0f0';
    into.append(box);
    return;
  }
  const crop = kid(fillEl, 'srcRect');
  const side = (name: string) => Number(attr(crop, name) ?? '0') / 100_000;
  const l = side('l');
  const r = side('r');
  const top = side('t');
  const b = side('b');
  const img = el('img', { position: 'absolute', display: 'block', maxWidth: 'none' });
  const sx = 1 / Math.max(0.01, 1 - l - r);
  const sy = 1 / Math.max(0.01, 1 - top - b);
  img.style.width = `${sx * 100}%`;
  img.style.height = `${sy * 100}%`;
  img.style.left = `${-l * sx * 100}%`;
  img.style.top = `${-top * sy * 100}%`;
  (img as HTMLImageElement).src = url;
  (img as HTMLImageElement).alt = '';
  (img as HTMLImageElement).draggable = false;
  box.append(img);
  into.append(box);
}

/** A table, a chart or other graphic: tables are drawn, the rest is a labelled box. */
function drawFrame(c: Ctx, shape: Element, t: Transform, into: HTMLElement): void {
  const xfrm = frameOf(kid(shape, 'xfrm'));
  if (!xfrm) return;
  const frame: Frame = {
    ...xfrm,
    x: t.ax * xfrm.x + t.bx,
    y: t.ay * xfrm.y + t.by,
    w: xfrm.w * t.ax,
    h: xfrm.h * t.ay,
  };
  const table = all(shape, 'tbl')[0];
  const box = el('div');
  place(box, frame, c);
  if (!table) {
    box.style.cssText +=
      ';background:#f5f5f5;border:1px dashed #c8c8c8;display:grid;place-items:center;color:#767676';
    box.style.fontSize = pt(14, c);
    box.textContent = all(shape, 'chart').length > 0 ? 'Chart' : 'Graphic';
    into.append(box);
    return;
  }
  const grid = kids(kid(table, 'tblGrid'), 'gridCol').map((g) => Number(attr(g, 'w')));
  const total = grid.reduce((a, b) => a + b, 0) || frame.w;
  const props = kid(table, 'tblPr');
  const header = attr(props, 'firstRow') === '1';
  const banded = attr(props, 'bandRow') === '1';
  const accent = c.theme['accent1'] ?? '4472C4';
  const tableEl = document.createElement('table');
  Object.assign(tableEl.style, {
    width: '100%',
    height: '100%',
    borderCollapse: 'collapse',
    tableLayout: 'fixed',
  });
  const colgroup = document.createElement('colgroup');
  for (const w of grid) colgroup.append(el('col', { width: `${(w * 100) / total}%` }));
  tableEl.append(colgroup);
  kids(table, 'tr').forEach((tr, r) => {
    const row = tableEl.insertRow();
    const height = Number(attr(tr, 'h'));
    if (height) row.style.height = `${(height * 100) / frame.h}%`;
    for (const tc of kids(tr, 'tc')) {
      if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') continue;
      const cell = row.insertCell();
      const span = Number(attr(tc, 'gridSpan') ?? '1');
      const down = Number(attr(tc, 'rowSpan') ?? '1');
      if (span > 1) cell.colSpan = span;
      if (down > 1) cell.rowSpan = down;
      const tcPr = kid(tc, 'tcPr');
      const own = fillOf(tcPr, c);
      const styled = header && r === 0;
      const fill =
        own ??
        (styled
          ? `#${accent}`
          : banded && r % 2 === 1
            ? `#${lightness(accent, 0.2, 0.8)}`
            : undefined);
      if (fill) cell.style.background = fill;
      cell.style.border = `${cq(6_350, c)} solid ${fill ? '#ffffff' : '#d0d0d0'}`;
      cell.style.padding = `${cq(45_720, c)} ${cq(91_440, c)}`;
      cell.style.verticalAlign = attr(tcPr, 'anchor') === 'ctr' ? 'middle' : 'top';
      const textBody = kid(tc, 'txBody');
      for (const p of kids(textBody, 'p')) {
        const line = el('div', { margin: '0', lineHeight: '1.2' });
        const align = attr(kid(p, 'pPr'), 'algn');
        if (align === 'ctr') line.style.textAlign = 'center';
        else if (align === 'r') line.style.textAlign = 'right';
        let any = false;
        for (const run of kids(p, 'r')) {
          const text = kid(run, 't')?.textContent ?? '';
          const look = levelOf(kid(run, 'rPr'), c);
          const span = el('span', { fontSize: pt(look.size ?? 18, c) });
          if (look.bold || styled) span.style.fontWeight = '700';
          if (look.italic) span.style.fontStyle = 'italic';
          span.style.color = look.color ?? (styled ? '#ffffff' : '#000000');
          span.textContent = text;
          line.append(span);
          any = any || text !== '';
        }
        if (!any) line.textContent = '​';
        cell.append(line);
      }
    }
  });
  box.append(tableEl);
  into.append(box);
}

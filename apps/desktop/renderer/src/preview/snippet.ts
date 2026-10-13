import { previewKind, type PreviewFile } from './kinds.ts';
import { docxLines, embeddedThumbnail, pptxSlides, xlsxSheets, type Sheet } from './office.ts';
import { parseCsv } from './grid.ts';
import { pdfThumbnail } from './pdf.ts';
import { decodeText, readFileBytes } from './source.ts';

/** What the chat bubble shows of a file: a picture, a few lines, a few cells, or nothing. */
export type Snippet =
  | { kind: 'image'; url: string; pages?: number }
  | { kind: 'lines'; lines: string[]; mono: boolean }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'none' };

const NONE: Snippet = { kind: 'none' };
/** Office files bigger than this are not opened just to draw a bubble. */
const OFFICE_BUBBLE_LIMIT = 12 * 1024 * 1024;

const cache = new Map<string, Promise<Snippet>>();
/** Files are unzipped one at a time, so a chat full of them never stalls the window. */
let chain: Promise<unknown> = Promise.resolve();

const corner = (sheet: Sheet | undefined): Snippet =>
  sheet && sheet.rows.length > 0
    ? {
        kind: 'table',
        rows: sheet.rows
          .slice(0, 7)
          .map((r) => Array.from({ length: Math.min(6, r.length) }, (_, i) => r[i] ?? '')),
      }
    : NONE;

async function build(file: PreviewFile): Promise<Snippet> {
  const kind = previewKind(file);
  switch (kind) {
    case 'pdf': {
      const { url, pages } = await pdfThumbnail(file, 640);
      return { kind: 'image', url, pages };
    }
    case 'text': {
      const { bytes } = await readFileBytes(file, 8_000);
      const text = decodeText(bytes);
      return text === undefined
        ? NONE
        : { kind: 'lines', lines: text.split(/\r?\n/).slice(0, 14), mono: true };
    }
    case 'csv': {
      const { bytes } = await readFileBytes(file, 24_000);
      const text = decodeText(bytes);
      return text === undefined ? NONE : corner(parseCsv(text, /\.tsv$/i.test(file.name)));
    }
    case 'docx':
    case 'xlsx':
    case 'pptx': {
      if (file.size > OFFICE_BUBBLE_LIMIT) return NONE;
      const { bytes } = await readFileBytes(file, file.size);
      if (kind === 'xlsx') return corner(xlsxSheets(bytes, true)[0]);
      const thumbnail = embeddedThumbnail(bytes);
      if (thumbnail) return { kind: 'image', url: thumbnail };
      if (kind === 'docx') {
        const lines = docxLines(bytes);
        return lines.length > 0 ? { kind: 'lines', lines, mono: false } : NONE;
      }
      const first = pptxSlides(bytes, 1).slides[0];
      const lines = first ? [first.title, ...first.lines.map((l) => l.text)].filter(Boolean) : [];
      return lines.length > 0 ? { kind: 'lines', lines: lines.slice(0, 12), mono: false } : NONE;
    }
    default:
      return NONE;
  }
}

/** The bubble's preview of a complete file (cached; a file that cannot be read has none). */
export function snippetFor(file: PreviewFile): Promise<Snippet> {
  let found = cache.get(file.sha256);
  if (!found) {
    const run = chain.then(() => build(file)).catch((): Snippet => NONE);
    chain = run;
    found = run;
    cache.set(file.sha256, found);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return found;
}

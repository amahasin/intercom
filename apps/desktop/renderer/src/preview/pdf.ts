import type { PDFDocumentProxy, PDFPageProxy, PDFWorker, RenderTask } from 'pdfjs-dist';
import type { PreviewFile } from './kinds.ts';
import { fileHref } from './source.ts';

import type * as PdfjsModule from 'pdfjs-dist';

type Pdfjs = typeof PdfjsModule;

/** pdf.js and its worker load the first time a PDF is shown, not with the app. */
let loading: Promise<{ pdfjs: Pdfjs; worker: PDFWorker }> | undefined;

function library(): Promise<{ pdfjs: Pdfjs; worker: PDFWorker }> {
  loading ??= (async () => {
    const [pdfjs, workerModule] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
    // One worker serves every document: a chat with many PDFs does not start many threads.
    return { pdfjs, worker: new pdfjs.PDFWorker() };
  })();
  return loading;
}

/** Fonts, character maps and image decoders ship with the app (copied at build time). */
const assets = () => new URL('./pdfjs/', document.baseURI).href;

export async function loadPdfjs(): Promise<Pdfjs> {
  return (await library()).pdfjs;
}

/** Open a PDF. It is read in byte ranges, so a big PDF shows its first page at once. */
export async function openPdf(file: PreviewFile): Promise<PDFDocumentProxy> {
  const { pdfjs, worker } = await library();
  const base = assets();
  return pdfjs.getDocument({
    url: fileHref(file),
    worker,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    enableXfa: false,
  }).promise;
}

/**
 * Start drawing a page on a canvas at `scale` css pixels per PDF point. The canvas is sized
 * here (sharp on high-density screens, never above about 16 megapixels); cancel the task
 * before drawing on the same canvas again.
 */
export function startRender(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
): { task: RenderTask; width: number; height: number } {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const natural = page.getViewport({ scale: scale * ratio });
  const limit = Math.min(1, Math.sqrt(16_000_000 / (natural.width * natural.height)));
  const viewport = limit < 1 ? page.getViewport({ scale: scale * ratio * limit }) : natural;
  const width = Math.floor(page.getViewport({ scale }).width);
  const height = Math.floor(page.getViewport({ scale }).height);
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport });
  return { task, width, height };
}

/** The first page as a picture for the chat bubble: at most two at a time, remembered. */
const thumbs = new Map<string, { url: string; pages: number }>();
const waiting: Array<() => void> = [];
let busy = 0;

export async function pdfThumbnail(
  file: PreviewFile,
  width: number,
): Promise<{ url: string; pages: number }> {
  const known = thumbs.get(file.sha256);
  if (known) return known;
  while (busy >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  busy++;
  try {
    const doc = await openPdf(file);
    try {
      const page = await doc.getPage(1);
      const natural = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      await startRender(page, canvas, width / natural.width).task.promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The first page could not be drawn.');
      const made = { url: URL.createObjectURL(blob), pages: doc.numPages };
      thumbs.set(file.sha256, made);
      if (thumbs.size > 120) {
        const oldest = thumbs.keys().next().value!;
        URL.revokeObjectURL(thumbs.get(oldest)!.url);
        thumbs.delete(oldest);
      }
      return made;
    } finally {
      void doc.loadingTask.destroy();
    }
  } finally {
    busy--;
    waiting.shift()?.();
  }
}

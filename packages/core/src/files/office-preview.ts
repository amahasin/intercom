import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { OfficeApp, OfficeHost } from '../core.ts';
import type { Logger } from '../interfaces.ts';

/**
 * Word, Excel and PowerPoint files drawn by Office (M6.30): the host saves a copy as a PDF, the core
 * keeps it by the file's hash (so it is drawn once, and a PDF that exists is never wrong), and the
 * viewer shows it like any other PDF. One file at a time: Office is heavy and a chat can hold many.
 */

/** The type the viewer's page asks for to read such a PDF (`/previews/<sha256>`). */
export const OFFICE_PREVIEW_TYPE = 'preview/pdf';

/** Which program draws which kind of file (by extension, lower case). */
export const OFFICE_EXTENSIONS: Readonly<Record<string, OfficeApp>> = {
  doc: 'word',
  docx: 'word',
  docm: 'word',
  rtf: 'word',
  odt: 'word',
  xls: 'excel',
  xlsx: 'excel',
  xlsm: 'excel',
  xlsb: 'excel',
  ods: 'excel',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
  pptm: 'powerpoint',
  pps: 'powerpoint',
  ppsx: 'powerpoint',
  odp: 'powerpoint',
};

/** Modern Office files are zip files; one that starts like an old file is sealed with a password. */
const MODERN = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'ppsx']);

export const OFFICE_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;
/** Drawn PDFs kept for next time: up to this many files and bytes (the oldest go first). */
const KEEP_FILES = 300;
const KEEP_BYTES = 400 * 1024 * 1024;
/** A file Office would not open is not tried again at once. */
const RETRY_AFTER_MS = 10 * 60_000;

export type OfficePreviewResult =
  | { state: 'ready' }
  | { state: 'unavailable'; message?: string }
  | { state: 'failed'; message: string };

export interface OfficePreviewOptions {
  /** Where the PDFs are kept. */
  dir: string;
  host: () => OfficeHost | undefined;
  logger: Logger;
  now: () => number;
}

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

function startsLikeZip(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    return head[0] === 0x50 && head[1] === 0x4b;
  } finally {
    closeSync(fd);
  }
}

export class OfficePreviews {
  readonly dir: string;
  private readonly o: OfficePreviewOptions;
  private readonly running = new Map<string, Promise<OfficePreviewResult>>();
  private readonly failures = new Map<string, { at: number; message: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: OfficePreviewOptions) {
    this.o = options;
    this.dir = options.dir;
  }

  /** The PDF drawn earlier for this file, if there is one. */
  cached(sha: string): string | null {
    const path = join(this.dir, `${sha}.pdf`);
    return existsSync(path) ? path : null;
  }

  make(sha: string, name: string, source: string, size: number): Promise<OfficePreviewResult> {
    const ext = extensionOf(name);
    const app = OFFICE_EXTENSIONS[ext];
    if (!app) return Promise.resolve({ state: 'unavailable' });
    if (this.cached(sha)) return Promise.resolve({ state: 'ready' });
    if (size > OFFICE_PREVIEW_MAX_BYTES)
      return Promise.resolve({ state: 'failed', message: 'This file is too big to draw here.' });
    const failed = this.failures.get(sha);
    if (failed && this.o.now() - failed.at < RETRY_AFTER_MS)
      return Promise.resolve({ state: 'failed', message: failed.message });
    let started = this.running.get(sha);
    if (!started) {
      const run = this.chain.then(() => this.draw(sha, app, ext, source));
      this.chain = run.catch(() => undefined);
      started = run.finally(() => this.running.delete(sha));
      this.running.set(sha, started);
    }
    return started;
  }

  private async draw(
    sha: string,
    app: OfficeApp,
    ext: string,
    source: string,
  ): Promise<OfficePreviewResult> {
    const host = this.o.host();
    if (!host) return { state: 'unavailable' };
    try {
      if (!(await host.apps())[app]) return { state: 'unavailable' };
      if (MODERN.has(ext) && !startsLikeZip(source))
        throw new Error('This file is protected with a password, so it cannot be drawn here.');
      mkdirSync(this.dir, { recursive: true });
      const partial = join(this.dir, `${sha}.partial.pdf`);
      rmSync(partial, { force: true });
      await host.toPdf({ app, source, extension: ext, target: partial });
      renameSync(partial, join(this.dir, `${sha}.pdf`));
      this.prune();
      return { state: 'ready' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Office could not open this file.';
      this.o.logger.warn('a file could not be drawn with Office', {
        app,
        message,
        detail: String((err as { cause?: unknown }).cause ?? ''),
      });
      this.failures.set(sha, { at: this.o.now(), message });
      return { state: 'failed', message };
    }
  }

  /** Keep the folder to a size: the oldest PDFs (and any half-written one) go. */
  private prune(): void {
    let rows: Array<{ path: string; size: number; at: number }>;
    try {
      rows = readdirSync(this.dir).map((f) => {
        const path = join(this.dir, f);
        const s = statSync(path);
        return { path, size: s.size, at: s.mtimeMs };
      });
    } catch {
      return;
    }
    rows.sort((a, b) => b.at - a.at);
    let bytes = 0;
    rows.forEach((r, i) => {
      bytes += r.size;
      if (i >= KEEP_FILES || bytes > KEEP_BYTES) rmSync(r.path, { force: true });
    });
  }
}

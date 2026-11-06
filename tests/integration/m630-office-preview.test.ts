import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, type OfficeHost, type OfficeJob } from '@officemesh/core';
import {
  OFFICE_PREVIEW_MAX_BYTES,
  OfficePreviews,
} from '../../packages/core/src/files/office-preview.ts';

const SHA = (n: number) => String(n).padStart(64, '0');
const ZIP = Buffer.from([0x50, 0x4b, 3, 4, 0, 0]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]);

let root: string;
let source: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'office-preview-'));
  source = join(root, 'source.bin');
  writeFileSync(source, ZIP);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in for the host: notes each job, takes a moment, and writes a PDF (or fails). */
function host(options: { installed?: boolean; fail?: string; ms?: number } = {}) {
  const jobs: OfficeJob[] = [];
  let running = 0;
  let most = 0;
  const h: OfficeHost = {
    async apps() {
      const on = options.installed ?? true;
      return { word: on, excel: on, powerpoint: on };
    },
    async toPdf(job) {
      jobs.push(job);
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, options.ms ?? 5));
      running--;
      if (options.fail) throw new Error(options.fail);
      writeFileSync(job.target, '%PDF-1.4 stand-in');
    },
  };
  return { h, jobs, most: () => most };
}

function previews(h: OfficeHost | undefined, clock = { now: 1_000_000 }) {
  const p = new OfficePreviews({
    dir: join(root, 'previews'),
    host: () => h,
    logger: silentLogger,
    now: () => clock.now,
  });
  return { p, clock };
}

describe('M6.30 Office files drawn by Office', () => {
  it('only kinds Office draws are asked for; a PC without Office, or without that program, says so', async () => {
    const none = host({ installed: false });
    expect(await previews(none.h).p.make(SHA(1), 'notes.docx', source, 10)).toEqual({
      state: 'unavailable',
    });
    expect(await previews(undefined).p.make(SHA(2), 'notes.docx', source, 10)).toEqual({
      state: 'unavailable',
    });
    const some = host();
    // A picture or a text file is nothing for Office to draw.
    expect(await previews(some.h).p.make(SHA(3), 'photo.png', source, 10)).toEqual({
      state: 'unavailable',
    });
    expect(some.jobs).toHaveLength(0);
  });

  it('draws a file once and keeps the PDF for next time', async () => {
    const h = host();
    const { p } = previews(h.h);
    expect(p.cached(SHA(1))).toBeNull();
    expect(await p.make(SHA(1), 'Budget.XLSX', source, 10)).toEqual({ state: 'ready' });
    expect(p.cached(SHA(1))).toBe(join(root, 'previews', `${SHA(1)}.pdf`));
    // The program for the extension, the extension Office opens it under, and a name ending in .pdf.
    expect(h.jobs[0]).toMatchObject({ app: 'excel', extension: 'xlsx', source });
    expect(h.jobs[0]!.target.endsWith('.pdf')).toBe(true);
    // Again: nothing is drawn.
    expect(await p.make(SHA(1), 'Budget.XLSX', source, 10)).toEqual({ state: 'ready' });
    expect(h.jobs).toHaveLength(1);
    // Nothing half-written is left in the folder.
    expect(readdirSync(join(root, 'previews'))).toEqual([`${SHA(1)}.pdf`]);
    // Each kind goes to its own program.
    await p.make(SHA(2), 'deck.ppt', source, 10);
    await p.make(SHA(3), 'letter.doc', source, 10);
    expect(h.jobs.map((j) => j.app)).toEqual(['excel', 'powerpoint', 'word']);
  });

  it('draws one file at a time, and asking twice for the same file draws it once', async () => {
    const h = host({ ms: 30 });
    const { p } = previews(h.h);
    const results = await Promise.all([
      p.make(SHA(1), 'a.docx', source, 10),
      p.make(SHA(1), 'a.docx', source, 10),
      p.make(SHA(2), 'b.docx', source, 10),
      p.make(SHA(3), 'c.docx', source, 10),
    ]);
    expect(results.map((r) => r.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(h.jobs).toHaveLength(3);
    expect(h.most()).toBe(1);
  });

  it('a file Office would not open says why, and is not tried again at once', async () => {
    const h = host({ fail: 'Office could not open this file.' });
    const { p, clock } = previews(h.h);
    const first = await p.make(SHA(1), 'broken.docx', source, 10);
    expect(first).toEqual({ state: 'failed', message: 'Office could not open this file.' });
    expect(p.cached(SHA(1))).toBeNull();
    expect(readdirSync(join(root, 'previews'))).toEqual([]);
    await p.make(SHA(1), 'broken.docx', source, 10);
    expect(h.jobs).toHaveLength(1);
    // Ten minutes later it is tried again.
    clock.now += 11 * 60_000;
    await p.make(SHA(1), 'broken.docx', source, 10);
    expect(h.jobs).toHaveLength(2);
  });

  it('a file sealed with a password, and a file that is too big, are refused before Office is started', async () => {
    const h = host();
    const { p } = previews(h.h);
    const sealed = join(root, 'sealed.docx');
    writeFileSync(sealed, OLE);
    const refused = await p.make(SHA(1), 'sealed.docx', sealed, 10);
    expect(refused).toMatchObject({ state: 'failed' });
    expect((refused as { message: string }).message).toMatch(/password/);
    // The old formats are OLE files by nature: they are handed to Office.
    expect(await p.make(SHA(2), 'old.doc', sealed, 10)).toEqual({ state: 'ready' });
    const big = await p.make(SHA(3), 'big.xlsx', source, OFFICE_PREVIEW_MAX_BYTES + 1);
    expect(big).toMatchObject({ state: 'failed' });
    expect(h.jobs.map((j) => j.extension)).toEqual(['doc']);
  });

  it('keeps the folder to a size: the oldest PDFs go first', async () => {
    const h = host();
    const { p } = previews(h.h);
    const dir = join(root, 'previews');
    mkdirSync(dir, { recursive: true });
    for (let i = 100; i < 400; i++) {
      const file = join(dir, `${SHA(i)}.pdf`);
      writeFileSync(file, 'x');
      const old = new Date(Date.now() - (1000 - i) * 60_000);
      utimesSync(file, old, old);
    }
    expect(readdirSync(dir)).toHaveLength(300);
    await p.make(SHA(1), 'new.docx', source, 10);
    const left = readdirSync(dir);
    expect(left.length).toBeLessThanOrEqual(300);
    expect(existsSync(join(dir, `${SHA(1)}.pdf`))).toBe(true);
    // The oldest of the old ones went; the newest stayed.
    expect(existsSync(join(dir, `${SHA(100)}.pdf`))).toBe(false);
    expect(existsSync(join(dir, `${SHA(399)}.pdf`))).toBe(true);
  });
});

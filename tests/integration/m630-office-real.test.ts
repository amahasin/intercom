/**
 * M6.30: the host really drawing a file with Word and Excel, on a PC that has them (the tests are
 * skipped on one that does not). It checks what matters when this runs on somebody's own PC: a PDF
 * comes out, a file Office cannot open is refused with a message, no Office program started for it
 * is left running, and a copy of Word or Excel the person was already using is never touched.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Job {
  app: 'word' | 'excel' | 'powerpoint';
  source: string;
  extension: string;
  target: string;
}
interface HostCode {
  officeApps(): Promise<Record<Job['app'], boolean>>;
  officeToPdf(job: Job): Promise<void>;
}
// The zip writer is the desktop app's (this project does not depend on it).
const { strToU8, zipSync } = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/package.json'),
)('fflate') as {
  strToU8(text: string): Uint8Array;
  zipSync(files: Record<string, Uint8Array>): Uint8Array;
};

// The host program's code, loaded by path (it belongs to the app's main process, which has its own
// build settings).
const host = (await import(
  pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/main/src/office-pdf.ts'),
  ).href
)) as HostCode;
const apps = process.platform === 'win32' ? await host.officeApps() : undefined;

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = `${HEAD}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OD}" Target="%TARGET%"/></Relationships>`;

const docx = () =>
  zipSync({
    '[Content_Types].xml': strToU8(
      `${HEAD}<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(RELS.replace('%TARGET%', 'word/document.xml')),
    'word/document.xml': strToU8(
      `${HEAD}<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Drawn by Word</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });

const xlsx = () =>
  zipSync({
    '[Content_Types].xml': strToU8(
      `${HEAD}<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(RELS.replace('%TARGET%', 'xl/workbook.xml')),
    'xl/workbook.xml': strToU8(
      `${HEAD}<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${HEAD}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `${HEAD}<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c></row></sheetData></worksheet>`,
    ),
  });

/** The ids of the copies of a program that were started for automation (the person's own are not among them). */
function automated(exe: string): number[] {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='${exe}.EXE'" | Where-Object { $_.CommandLine -match '-Embedding' } | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return out.split(/\s+/).filter(Boolean).map(Number).sort();
}

/** The ids of the copies the person opened themselves. */
function personal(exe: string): number[] {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='${exe}.EXE'" | Where-Object { $_.CommandLine -notmatch '-Embedding' } | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return out.split(/\s+/).filter(Boolean).map(Number).sort();
}

describe.skipIf(!apps?.word || !apps.excel)('M6.30 drawing with the real Office', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'intercom-office-real-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const draw = async (app: Job['app'], extension: string, bytes: Uint8Array | string) => {
    const source = join(dir, `in-${extension}.${extension}`);
    const target = join(dir, `out-${extension}.pdf`);
    writeFileSync(source, bytes);
    await host.officeToPdf({ app, source, extension, target });
    return target;
  };

  it('Word draws a document as a PDF, and leaves nothing running', async () => {
    const before = automated('WINWORD');
    const own = personal('WINWORD');
    const pdf = await draw('word', 'docx', docx());
    expect(readFileSync(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(automated('WINWORD')).toEqual(before);
    expect(personal('WINWORD')).toEqual(own);
  }, 120_000);

  it('Excel draws a workbook as a PDF without touching the Excel the person is using', async () => {
    const before = automated('EXCEL');
    const own = personal('EXCEL');
    const pdf = await draw('excel', 'xlsx', xlsx());
    expect(readFileSync(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(automated('EXCEL')).toEqual(before);
    // The person's Excel (if one is open) is the very same process, still there.
    expect(personal('EXCEL')).toEqual(own);
  }, 120_000);

  it('a file Office cannot open is refused with a message, and nothing is left running', async () => {
    const before = automated('WINWORD');
    await expect(draw('word', 'docx', 'this is not a Word document')).rejects.toThrow(
      /could not open|password/,
    );
    expect(automated('WINWORD')).toEqual(before);
  }, 120_000);
});

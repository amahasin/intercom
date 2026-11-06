import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OfficeApps, OfficeHost, OfficeJob } from '@officemesh/core';

/**
 * Word, Excel and PowerPoint files drawn by the programs that made them: the file is opened in a
 * hidden copy of the program, read only, and saved as a PDF, which the viewer then shows like any
 * other PDF (all pages, search, zoom). Nothing is installed; a PC without Office just keeps the
 * built-in drawing.
 *
 * Opening a colleague's file in Office is not like clicking it in Explorer: there is no Protected
 * View here, so the program is told to run nothing from it (macros off, links not updated, no
 * dialogs), to open it read only, and never to save it. The program is always one this code started
 * itself (`/Automation -Embedding`): a copy of Word or Excel the person is working in is never used,
 * closed or touched, and if it cannot be told apart the file is simply not drawn by Office.
 */
const SYSTEM32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
const POWERSHELL = join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const REG = join(SYSTEM32, 'reg.exe');

/** How long Office gets for one file (a first start can take several seconds). */
export const OFFICE_TIMEOUT_MS = 90_000;

const PROG_IDS: Record<OfficeJob['app'], string> = {
  word: 'Word.Application',
  excel: 'Excel.Application',
  powerpoint: 'PowerPoint.Application',
};

function registered(progId: string): Promise<boolean> {
  return new Promise((resolve) =>
    execFile(
      REG,
      ['query', `HKCR\\${progId}\\CLSID`],
      { timeout: 10_000, windowsHide: true },
      (err) => resolve(!err),
    ),
  );
}

let known: Promise<OfficeApps> | undefined;

/** Which of the three programs are installed (asked of the registry once, not by starting them). */
export function officeApps(): Promise<OfficeApps> {
  known ??= Promise.all(
    (Object.keys(PROG_IDS) as Array<OfficeJob['app']>).map(
      async (app) => [app, await registered(PROG_IDS[app])] as const,
    ),
  ).then((rows) => Object.fromEntries(rows) as unknown as OfficeApps);
  return known;
}

/**
 * Runs in Windows PowerShell with the job (JSON, base64) on standard input. On a failure it prints
 * one line, `FAIL:<why>`, and exits with 1: `protected` (a password is needed), `shared` (the only
 * copy of the program running is not one it started), or `failed`.
 */
const CONVERT = `
$ErrorActionPreference = 'Stop'
$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
$exe = @{ word = 'WINWORD'; excel = 'EXCEL'; powerpoint = 'POWERPNT' }[$j.app]
$missing = [Type]::Missing
$password = 'InterCom-no-password'

# Office's methods take their arguments by reference; this passes them the way they expect.
function Call($target, $name, $arguments) {
  [System.__ComObject].InvokeMember($name, [Reflection.BindingFlags]::InvokeMethod, $null, $target, $arguments)
}

function Mine($before) {
  # Programs started for automation carry -Embedding; one the person opened does not.
  @(Get-CimInstance Win32_Process -Filter "Name='$exe.EXE'" -ErrorAction SilentlyContinue |
    Where-Object { $before -notcontains $_.ProcessId -and $_.CommandLine -match '-Embedding' } |
    ForEach-Object { $_.ProcessId })
}

$before = @(Get-Process -Name $exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$app = $null
$mine = @()
$doc = $null
try {
  $app = New-Object -ComObject @{ word = 'Word.Application'; excel = 'Excel.Application'; powerpoint = 'PowerPoint.Application' }[$j.app]
  for ($i = 0; $i -lt 30 -and $mine.Count -eq 0; $i++) { $mine = Mine $before; if ($mine.Count -eq 0) { Start-Sleep -Milliseconds 100 } }
  if ($mine.Count -eq 0) { $app = $null; Write-Output 'FAIL:shared'; exit 1 }

  switch ($j.app) {
    'word' {
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $app.AutomationSecurity = 3
      try { $app.Options.UpdateLinksAtOpen = $false } catch {}
      $doc = Call $app.Documents 'Open' @($j.source, $false, $true, $false, $password, $missing, $false, $missing, $missing, $missing, $missing, $false, $false, $missing, $true)
      Call $doc 'ExportAsFixedFormat' @($j.target, 17, $false) | Out-Null
      Call $doc 'Close' @($false) | Out-Null
    }
    'excel' {
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $app.AutomationSecurity = 3
      $app.AskToUpdateLinks = $false
      $app.EnableEvents = $false
      $doc = Call $app.Workbooks 'Open' @($j.source, 0, $true, $missing, $password)
      # A sheet is one page wide, so its columns are not split over pages (never saved: read only).
      try {
        $app.PrintCommunication = $false
        foreach ($ws in $doc.Worksheets) {
          try { $ws.PageSetup.Zoom = $false; $ws.PageSetup.FitToPagesWide = 1; $ws.PageSetup.FitToPagesTall = $false } catch {}
        }
        $app.PrintCommunication = $true
      } catch {}
      Call $doc 'ExportAsFixedFormat' @(0, $j.target, 0, $true, $false, $missing, $missing, $false) | Out-Null
      Call $doc 'Close' @($false) | Out-Null
    }
    'powerpoint' {
      try { $app.AutomationSecurity = 3 } catch {}
      $doc = $app.Presentations.Open($j.source, -1, 0, 0)
      $doc.SaveAs($j.target, 32)
      $doc.Close()
    }
  }
  if (-not (Test-Path -LiteralPath $j.target)) { Write-Output 'FAIL:failed'; exit 1 }
} catch {
  if ($_.Exception.Message -match 'password|protected|encrypted') { Write-Output 'FAIL:protected' } else { Write-Output 'FAIL:failed' }
  Write-Output ('DETAIL:' + ($_.Exception.Message -replace '\\s+', ' '))
  exit 1
} finally {
  if ($app) { try { if ($j.app -eq 'word') { $app.Quit($false) } else { $app.Quit() } } catch {} }
  if ($mine.Count -gt 0) {
    for ($i = 0; $i -lt 50 -and (Get-Process -Id $mine -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
    Get-Process -Id $mine -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}
`;
const CONVERT_ENCODED = Buffer.from(CONVERT, 'utf16le').toString('base64');

const MESSAGES: Record<string, string> = {
  protected: 'This file is protected with a password, so it cannot be drawn here.',
  shared: 'Office is already running for another reason, so this file was not opened in it.',
  failed: 'Office could not open this file.',
};

/** Programs this code started and may still be running, for a clean up after a time out. */
function sweep(app: OfficeJob['app'], since: Date): Promise<void> {
  const exe = { word: 'WINWORD', excel: 'EXCEL', powerpoint: 'POWERPNT' }[app];
  const script = `Get-CimInstance Win32_Process -Filter "Name='${exe}.EXE'" | Where-Object { $_.CommandLine -match '-Embedding' -and $_.CreationDate -gt [datetime]'${since.toISOString()}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return new Promise((resolve) =>
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 15_000, windowsHide: true },
      () => resolve(),
    ),
  );
}

/**
 * Save `job.source` as a PDF at `job.target` with the program for it. The file is first copied to
 * a name of its own under the extension it needs (the stored copy is never opened, so Office cannot
 * lock or change it). Rejects with a message that is fit to show.
 */
export async function officeToPdf(job: OfficeJob): Promise<void> {
  const apps = await officeApps();
  if (!apps[job.app]) throw new Error('Office is not installed on this PC.');
  const folder = mkdtempSync(join(tmpdir(), 'intercom-office-'));
  const copy = join(folder, `file.${job.extension}`);
  try {
    copyFileSync(job.source, copy);
    await run({ ...job, source: copy });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function run(job: OfficeJob): Promise<void> {
  const started = new Date(Date.now() - 2_000);
  let detail = '';
  const why = await new Promise<string | undefined>((resolve) => {
    const child = execFile(
      POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        CONVERT_ENCODED,
      ],
      { timeout: OFFICE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        detail = /DETAIL:(.*)/.exec(String(stdout))?.[1]?.trim() ?? String(stderr).trim();
        const fail = /FAIL:(\w+)/.exec(String(stdout))?.[1];
        if (fail) return resolve(fail);
        if (err) return resolve((err as { killed?: boolean }).killed ? 'timeout' : 'failed');
        resolve(undefined);
      },
    );
    const body = JSON.stringify({ app: job.app, source: job.source, target: job.target });
    child.stdin?.end(Buffer.from(body, 'utf8').toString('base64'));
  });
  if (why === 'timeout') await sweep(job.app, started);
  if (why)
    // What Office itself said goes to the log (as `cause`), not to the person.
    throw new Error(
      why === 'timeout'
        ? 'Office took too long to open this file.'
        : (MESSAGES[why] ?? MESSAGES['failed']!),
      { cause: detail },
    );
}

/** One page with one line of text (Helvetica, so nothing needs embedding): what the stand-in "draws". */
function onePagePdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Tests: note what would have been drawn in a file, and write a small PDF instead of starting Office. */
export function fakeOffice(report: string): OfficeHost {
  // `off`: a PC without Office (what every test that is not about Office runs as).
  const installed = report !== 'off';
  return {
    async apps() {
      return { word: installed, excel: installed, powerpoint: installed };
    },
    async toPdf(job) {
      appendFileSync(
        report,
        `${JSON.stringify({ app: job.app, extension: job.extension, source: job.source })}\n`,
      );
      writeFileSync(job.target, onePagePdf(`Drawn by Office as ${job.app}`));
    },
  };
}

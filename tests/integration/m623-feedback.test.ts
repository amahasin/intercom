import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FOLDER_MIME, UNHASHED_MANIFEST } from '@officemesh/protocol';
import type { FileStatus, FileUpload } from '@officemesh/protocol/ipc';
import type { Core, CoreOptions } from '@officemesh/core';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { safeSegments } from '../../packages/core/src/files/folders.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `intercom-${prefix}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A folder with a few levels, an empty folder, a name with spaces and accents, and a file of some size. */
function sampleFolder(extraSmallFiles = 0): string {
  const root = join(scratch('src'), 'Reports 2026');
  mkdirSync(join(root, 'q1', 'drafts'), { recursive: true });
  mkdirSync(join(root, 'empty'), { recursive: true });
  writeFileSync(join(root, 'readme.txt'), 'Hello\n'.repeat(50));
  writeFileSync(join(root, 'q1', 'résumé € 日本.txt'), 'unicode name');
  writeFileSync(join(root, 'q1', 'drafts', 'a.bin'), Buffer.from([0, 1, 2, 3, 255, 254]));
  const big = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 0xff;
  writeFileSync(join(root, 'big.dat'), big);
  writeFileSync(join(root, 'zero.txt'), '');
  if (extraSmallFiles > 0) {
    mkdirSync(join(root, 'many'), { recursive: true });
    for (let i = 0; i < extraSmallFiles; i++)
      writeFileSync(join(root, 'many', `f${String(i).padStart(5, '0')}.txt`), `file ${i}\n`);
  }
  return root;
}

function tree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (e.isDirectory())
      out.push(`${prefix}${e.name}/`, ...tree(join(dir, e.name), `${prefix}${e.name}/`));
    else out.push(`${prefix}${e.name}`);
  }
  return out;
}

const everyFile = (dir: string): string[] => tree(dir).filter((p) => !p.endsWith('/'));

describe('M6.23 names inside a folder', () => {
  it('a name that climbs out of the folder, names a drive or a stream, or is reserved is not taken as it is', () => {
    expect(safeSegments('../evil.exe')).toBeUndefined();
    expect(safeSegments('a/../../evil.exe')).toBeUndefined();
    expect(safeSegments('C:\\Windows\\x.dll')).toBeUndefined();
    expect(safeSegments('file.txt:stream')).toBeUndefined();
    expect(safeSegments('')).toBeUndefined();
    expect(safeSegments('/abs/path.txt')).toEqual(['abs', 'path.txt']);
    expect(safeSegments('dir\\sub/file.txt')).toEqual(['dir', 'sub', 'file.txt']);
    expect(safeSegments('nul.txt')).toEqual(['_nul.txt']);
    expect(safeSegments('bad<name>?.txt')).toEqual(['bad_name__.txt']);
    expect(safeSegments('trailing. ')).toEqual(['trailing']);
  });
});

describe('M6.23 sending a folder to a colleague', () => {
  let sims: InProcessSim[] = [];
  afterEach(async () => {
    for (const s of sims) await s.stop();
    sims = [];
  });

  async function lan(): Promise<{ a: Core; b: Core; opened: string[]; saveDir: string }> {
    const saveDir = scratch('save');
    const opened: string[] = [];
    const sim = await startInProcessPeers({
      count: 2,
      coreOptions: (i) => ({
        downloadsDir: saveDir + (i === 0 ? '-a' : ''),
        host: { openPath: (p: string) => void opened.push(p) } as unknown as CoreOptions['host'],
      }),
    });
    sims.push(sim);
    const [a, b] = sim.peers.map((p) => p.core) as [Core, Core];
    const start = Date.now();
    while (!(
      a.people().some((p) => p.userId === b.userId && p.online && p.displayName) &&
      b.people().some((p) => p.userId === a.userId && p.online && p.displayName)
    )) {
      if (Date.now() - start > 20_000) throw new Error('discovery timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
    return { a, b, opened, saveDir };
  }

  const until = async (what: string, ms: number, check: () => boolean) => {
    const start = Date.now();
    for (;;) {
      let ok = false;
      try {
        ok = check();
      } catch {
        // not there yet (the conversation has not reached them)
      }
      if (ok) return;
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it(
    'shows the sender the folder going out as one transfer to each colleague, and clears it when they have it',
    { timeout: 120_000 },
    async () => {
      const { a, b } = await lan();
      const source = sampleFolder(300);
      const expectedBytes = everyFile(source).reduce(
        (n, f) => n + statSync(join(source, f)).size,
        0,
      );
      const conv = a.openDirect(b.userId).convId;
      const uploads: Array<{ sha256: string; uploads: FileUpload[] }> = [];
      a.onEvent(
        (name, payload) =>
          name === 'files.upload' &&
          uploads.push(payload as { sha256: string; uploads: FileUpload[] }),
      );
      const sha = (await a.shareFile({ convId: conv, path: source })).file!.sha256;
      await until('the folder', 90_000, () => b.fileStatus(sha).state === 'complete');
      // A few seconds after the last byte, nothing is being sent any more: the card clears.
      await until(
        'the card to clear',
        20_000,
        () => uploads.at(-1)?.sha256 === sha && uploads.at(-1)!.uploads.length === 0,
      );

      // On the folder's own card (the message's file), as one transfer to Bob.
      const toBob = uploads
        .filter((e) => e.sha256 === sha)
        .flatMap((e) => e.uploads)
        .filter((u) => u.userId === b.userId);
      expect(toBob.length).toBeGreaterThan(0);
      // Out of everything in the folder (not out of its small index file), reaching all of it...
      expect(new Set(toBob.map((u) => u.total))).toEqual(new Set([expectedBytes]));
      expect(Math.max(...toBob.map((u) => u.sent))).toBe(expectedBytes);
      // ...without ever going back, and with a speed while it went.
      for (let i = 1; i < toBob.length; i++)
        expect(toBob[i]!.sent).toBeGreaterThanOrEqual(toBob[i - 1]!.sent);
      expect(toBob.some((u) => u.bytesPerSecond > 0)).toBe(true);
      // The files inside it do not report on their own.
      const memberIds = new Set<string>(
        a.store.db
          .prepare('SELECT sha256 FROM files WHERE folder_sha = ?')
          .pluck()
          .all(sha) as string[],
      );
      expect(uploads.some((e) => memberIds.has(e.sha256))).toBe(false);
    },
  );

  it(
    'goes out as the tree it is (no packing), arrives folder by folder and file by file, and opens',
    { timeout: 120_000 },
    async () => {
      const { a, b, opened, saveDir } = await lan();
      const source = sampleFolder(1200);
      const files = everyFile(source);
      const expectedBytes = files.reduce((n, f) => n + statSync(join(source, f)).size, 0);
      const conv = a.openDirect(b.userId).convId;
      const sharedMsg = await a.shareFile({ convId: conv, path: source });
      // The message holds the folder's index; the folder's size and number of files are on it.
      expect(sharedMsg.file).toMatchObject({
        name: 'Reports 2026',
        mime: FOLDER_MIME,
        folder: { files: files.length, bytes: expectedBytes },
      });
      expect(sharedMsg.file!.manifest).not.toBe(UNHASHED_MANIFEST);
      // Nothing was packed: only the index was written (a few lines of text).
      const written = readdirSync(join(a.files.dir, 'folders'));
      expect(written.every((n) => n.endsWith('.jsonl'))).toBe(true);

      const sha = sharedMsg.file!.sha256;
      const seen: FileStatus[] = [];
      b.onEvent((name, payload) => name === 'files.progress' && seen.push(payload as FileStatus));
      await until('the message', 10_000, () =>
        b.listMessages(conv).some((m) => m.file?.sha256 === sha),
      );
      // Files arrive by themselves (the default): the folder does too.
      await until('the folder', 90_000, () => b.fileStatus(sha).state === 'complete');

      // The folder as one transfer: its size is what is in it, and it was seen going.
      expect(b.fileStatus(sha)).toMatchObject({ state: 'complete', size: expectedBytes });
      expect(seen.some((s) => s.sha256 === sha && s.state === 'downloading')).toBe(true);
      // The files inside it do not report one by one.
      const memberIds = new Set<string>(
        a.store.db
          .prepare('SELECT sha256 FROM files WHERE folder_sha = ?')
          .pluck()
          .all(sha) as string[],
      );
      expect(memberIds.size).toBe(files.length);
      expect(seen.some((s) => memberIds.has(s.sha256))).toBe(false);

      // Opening it shows the folder made on this PC, with everything in it.
      await b.openFile(sha);
      expect(opened).toHaveLength(1);
      const folder = opened[0]!;
      expect(folder.startsWith(saveDir)).toBe(true);
      expect(tree(folder)).toEqual(tree(source));
      for (const f of [
        'readme.txt',
        'q1/résumé € 日本.txt',
        'q1/drafts/a.bin',
        'big.dat',
        'zero.txt',
      ])
        expect(readFileSync(join(folder, f))).toEqual(readFileSync(join(source, f)));
      expect(readFileSync(join(folder, 'many', 'f00123.txt'), 'utf8')).toBe('file 123\n');
      // Nothing half-done is left in it.
      expect(tree(folder).some((p) => p.includes('officemesh-part'))).toBe(false);

      // The sender opens the folder it sent, as it is.
      await a.openFile(sha);
      expect(opened[1]).toBe(source);
    },
  );

  it(
    'a folder index that names places outside the folder makes nothing there',
    { timeout: 60_000 },
    async () => {
      const { a, b, saveDir } = await lan();
      // A hand-made index, shared as a folder: names that climb out, one that is fine, and rubbish.
      const fineId = 'f'.repeat(64);
      const index = join(scratch('index'), 'index.jsonl');
      writeFileSync(
        index,
        [
          JSON.stringify({ f: '../escaped.txt', s: 5, i: 'e'.repeat(64) }),
          JSON.stringify({ f: 'sub/../../escaped2.txt', s: 5, i: 'd'.repeat(64) }),
          JSON.stringify({ f: 'ok/fine.txt', s: 4, i: fineId }),
          'this line is not json',
          JSON.stringify({ f: 'ok/negative.txt', s: -5, i: 'c'.repeat(64) }),
          JSON.stringify({ d: 'a/b/c' }),
        ].join('\n') + '\n',
      );
      const conv = a.openDirect(b.userId).convId;
      const msg = await a.shareFile({
        convId: conv,
        path: index,
        mime: FOLDER_MIME,
        name: 'Hand made',
      });
      const sha = msg.file!.sha256;
      await until('the message', 10_000, () =>
        b.listMessages(conv).some((m) => m.file?.sha256 === sha),
      );
      // The folder is made (its one safe file waits for a sender that does not have it).
      await until('the folder', 30_000, () => b.files.row(fineId) !== undefined);
      for (const id of ['e', 'd', 'c']) expect(b.files.row(id.repeat(64))).toBeUndefined();
      const root = join(saveDir, 'InterCom', 'Hand made');
      expect(existsSync(root)).toBe(true);
      expect(tree(root)).toEqual(['a/', 'a/b/', 'a/b/c/', 'ok/']);
      // Nothing was made beside it.
      expect(readdirSync(join(saveDir, 'InterCom')).some((n) => n.includes('escaped'))).toBe(false);
      expect(existsSync(join(saveDir, 'escaped.txt'))).toBe(false);
    },
  );

  it(
    'can be stopped half way and carried on, and made again if it was deleted',
    { timeout: 120_000 },
    async () => {
      const { a, b } = await lan();
      const source = sampleFolder(900);
      const total = everyFile(source).length;
      const conv = a.openDirect(b.userId).convId;
      const sha = (await a.shareFile({ convId: conv, path: source })).file!.sha256;
      await until('files coming', 30_000, () => {
        const row = b.store.db
          .prepare("SELECT count(*) FROM files WHERE folder_sha = ? AND state = 'complete'")
          .pluck()
          .get(sha) as number;
        return row > 20;
      });
      // Stopped: nothing more is fetched, and the folder is not complete.
      const stopped = await b.cancelDownload(sha);
      expect(stopped.state).toBe('missing');
      const countDone = () =>
        b.store.db
          .prepare("SELECT count(*) FROM files WHERE folder_sha = ? AND state = 'complete'")
          .pluck()
          .get(sha) as number;
      await new Promise((r) => setTimeout(r, 300));
      const doneThen = countDone();
      await new Promise((r) => setTimeout(r, 1_500));
      expect(countDone()).toBeLessThanOrEqual(doneThen + 12);
      expect(doneThen).toBeLessThan(total);
      // Carried on from where it was.
      b.downloadFile(sha);
      await until('the folder', 60_000, () => b.fileStatus(sha).state === 'complete');
      expect(countDone()).toBe(total);

      // The user deletes the folder: it is shown as gone, and fetched again when asked.
      const root = b.store.db
        .prepare('SELECT root FROM folder_xfers WHERE index_sha = ?')
        .pluck()
        .get(sha) as string;
      await rm(root, { recursive: true, force: true });
      expect(b.fileStatus(sha).state).toBe('gone');
      b.downloadFile(sha);
      await until('the folder again', 60_000, () => b.fileStatus(sha).state === 'complete');
      const again = b.store.db
        .prepare('SELECT root FROM folder_xfers WHERE index_sha = ?')
        .pluck()
        .get(sha) as string;
      expect(tree(again)).toEqual(tree(source));
    },
  );

  it('says so when a folder is not there any more', { timeout: 30_000 }, async () => {
    const { a, b } = await lan();
    const conv = a.openDirect(b.userId).convId;
    await expect(
      a.shareFile({ convId: conv, path: join(tmpdir(), 'intercom-no-such-folder-1234') }),
    ).rejects.toThrow();
  });
});

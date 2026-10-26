import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import {
  FILE_CHUNK_BYTES,
  FOLDER_MIME,
  MAX_FILE_BYTES,
  UNHASHED_MANIFEST,
  type FileRef,
} from '@officemesh/protocol';
import { safeFileName, uniqueName } from './names.ts';

export interface FileRow {
  sha256: string;
  name: string;
  size: number;
  mime: string;
  manifest: string;
  chunkCount: number;
  state: 'missing' | 'partial' | 'complete';
  have: Buffer | null;
  own: number;
  convId: string | null;
  /** Where the complete file is. Null on rows from before M6.1 (content-addressed in `dir`). */
  path: string | null;
  partPath: string | null;
  mtimeMs: number | null;
  /** Asked for and not here yet: fetched again whenever the sender can be reached. */
  wanted: number;
  /** A file inside a sent folder: the id of that folder's index (these are on no list of files). */
  folderSha: string | null;
}

/** A file shared as it is, with no fingerprint (see `UNHASHED_MANIFEST`). */
export const isUnhashed = (row: Pick<FileRow, 'manifest'>): boolean =>
  row.manifest === UNHASHED_MANIFEST;

/** What is on disk for a file this PC says it has. */
export type Presence = 'present' | 'gone' | 'changed';

export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / FILE_CHUNK_BYTES));
}

export const bitmap = {
  create: (n: number) => Buffer.alloc(Math.ceil(n / 8)),
  has: (b: Uint8Array, i: number) => (b[i >> 3]! & (1 << (i & 7))) !== 0,
  set: (b: Uint8Array, i: number) => {
    b[i >> 3] = b[i >> 3]! | (1 << (i & 7));
  },
  count: (b: Uint8Array, n: number) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (bitmap.has(b, i)) c++;
    return c;
  },
};

/** "Downloaded from another computer": Windows SmartScreen and Office Protected View apply. */
const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n';

/** A download in progress is `<name>.<sha8>.officemesh-part` in the folder it will land in. */
const PART_SUFFIX = 'officemesh-part';
/** A read handle on a file being served is let go after this long without a read. */
const READER_IDLE_MS = 3_000;

export interface FileStoreOptions {
  /** The folder received files are saved to (created when needed). */
  saveDir(): string;
}

/**
 * Files stay where they are (plan: a LAN messenger keeps no second copy). A file this PC
 * shares is read from its original path; a file it receives is written straight into the
 * folder the user chose, as `<name>.<sha8>.officemesh-part` until it checks out, then
 * renamed to its real name. Only per-chunk hash lists (`manifests/`) and pasted or
 * snipped pictures, which have no original, live in the app's own folder `dir`.
 *
 * Rows from before M6.1 point at nothing (`path` is null): those files are still
 * content-addressed as `<dir>/<sha256>`, and are read from there.
 */
export class FileStore {
  readonly dir: string;
  private readonly db: Database.Database;
  private readonly o: FileStoreOptions;
  private readonly handles = new Map<string, Promise<FileHandle>>();
  private readonly readers = new Map<
    string,
    { handle: Promise<FileHandle>; timer?: NodeJS.Timeout }
  >();
  /**
   * Chunks held by downloads in progress, newest first: the bitmap of a file of hundreds of GB
   * is many KB, so it goes to the database about once a second rather than with every chunk.
   */
  private readonly haveMem = new Map<string, { bits: Buffer; flushedAt: number }>();

  constructor(dir: string, db: Database.Database, options: FileStoreOptions) {
    this.dir = dir;
    this.db = db;
    this.o = options;
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, 'manifests'), { recursive: true });
  }

  /** The folder received files go to. */
  get saveDir(): string {
    return this.o.saveDir();
  }

  private legacyPath(sha: string): string {
    return join(this.dir, sha);
  }

  private manifestPath(sha: string): string {
    return join(this.dir, 'manifests', sha);
  }

  row(sha: string): FileRow | undefined {
    return this.db
      .prepare(
        `SELECT sha256, name, size, mime, manifest, chunk_count AS chunkCount, state, have, own,
                conv_id AS convId, path, part_path AS partPath, mtime_ms AS mtimeMs, wanted, folder_sha AS folderSha
           FROM files WHERE sha256 = ?`,
      )
      .get(sha) as FileRow | undefined;
  }

  /** Where the complete file is (or was). */
  path(sha: string): string {
    const row = this.row(sha);
    return row?.path ?? this.legacyPath(sha);
  }

  private partFile(row: FileRow): string {
    return row.partPath ?? join(this.dir, `${row.sha256}.part`);
  }

  /** Remember a file seen in a conversation (first sighting wins the name). */
  note(ref: FileRef, convId: string, now: number): FileRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO files (sha256, name, size, mime, manifest, chunk_count, state, own, conv_id, added_at)
         VALUES (?, ?, ?, ?, ?, ?, 'missing', 0, ?, ?)`,
      )
      .run(
        ref.sha256,
        ref.name,
        ref.size,
        ref.mime,
        ref.manifest,
        chunkCount(ref.size),
        convId,
        now,
      );
    // A folder's index is the program's own business, not a file for the save folder: it is kept
    // with the program's files, and the folder it describes is made in the save folder.
    if (ref.mime === FOLDER_MIME)
      this.db
        .prepare('UPDATE files SET part_path = ? WHERE sha256 = ? AND part_path IS NULL')
        .run(
          join(this.dir, 'folders', 'received', `${ref.sha256.slice(0, 16)}.officemesh-part`),
          ref.sha256,
        );
    return this.row(ref.sha256)!;
  }

  /**
   * Share the files of a folder as they are, many at once: one row each (a random id, no
   * fingerprint, served from where the file is), all in one transaction. `tag` marks them as
   * belonging to a folder whose index is not made yet (see `retag`).
   */
  importLiveBatch(
    files: Array<{ path: string; name: string; size: number; mtimeMs: number }>,
    convId: string,
    tag: string,
    now: number,
  ): string[] {
    const insert = this.db.prepare(
      `INSERT INTO files (sha256, name, size, mime, manifest, chunk_count, state, own, conv_id,
                          added_at, completed_at, path, mtime_ms, folder_sha)
       VALUES (?, ?, ?, 'application/octet-stream', ?, ?, 'complete', 1, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    this.db.transaction(() => {
      for (const f of files) {
        const id = randomBytes(32).toString('hex');
        insert.run(
          id,
          f.name,
          f.size,
          UNHASHED_MANIFEST,
          chunkCount(f.size),
          convId,
          now,
          now,
          resolve(f.path),
          Math.round(f.mtimeMs),
          tag,
        );
        ids.push(id);
      }
    })();
    return ids;
  }

  /** Let go of what is held open for the files of a folder whose rows are about to be removed. */
  purgeFolder(folderSha: string): void {
    const shas = this.db
      .prepare('SELECT sha256 FROM files WHERE folder_sha = ?')
      .pluck()
      .all(folderSha) as string[];
    for (const sha of shas) {
      this.haveMem.delete(sha);
      const handle = this.handles.get(sha);
      if (handle) {
        this.handles.delete(sha);
        void handle.then((fh) => fh.close()).catch(() => {});
      }
    }
  }

  /** The bytes in all the files of a folder (its index file not counted). */
  folderBytes(folderSha: string): number {
    return (
      (this.db
        .prepare('SELECT COALESCE(SUM(size), 0) FROM files WHERE folder_sha = ?')
        .pluck()
        .get(folderSha) as number) ?? 0
    );
  }

  /** The files tagged while a folder was being shared now belong to its index. */
  retagFolder(tag: string, indexSha: string): void {
    this.db.prepare('UPDATE files SET folder_sha = ? WHERE folder_sha = ?').run(indexSha, tag);
  }

  /** Forget the files of a folder that could not be shared. */
  dropFolderFiles(folderSha: string): void {
    this.db.prepare('DELETE FROM files WHERE folder_sha = ?').run(folderSha);
  }

  /**
   * The files of a folder being received: noted as not here yet, each to be written where it
   * belongs in the folder (the part file is already in its place, and the finished file is named
   * there).
   */
  noteFolderFiles(
    items: Array<{ ref: FileRef; partPath: string }>,
    convId: string,
    folderSha: string,
    now: number,
  ): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO files (sha256, name, size, mime, manifest, chunk_count, state, own,
                                    conv_id, added_at, part_path, folder_sha)
       VALUES (?, ?, ?, ?, ?, ?, 'missing', 0, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const { ref, partPath } of items)
        insert.run(
          ref.sha256,
          ref.name,
          ref.size,
          ref.mime,
          ref.manifest,
          chunkCount(ref.size),
          convId,
          now,
          partPath,
          folderSha,
        );
    })();
  }

  /**
   * What is on disk for a complete file: still there, gone, or changed since it was shared
   * (a shared original that was edited no longer matches its fingerprint).
   */
  presence(row: FileRow): Presence {
    const path = row.path ?? this.legacyPath(row.sha256);
    let info;
    try {
      info = statSync(path);
    } catch {
      return 'gone';
    }
    if (!info.isFile()) return 'gone';
    // A file this PC shared must still be the file it fingerprinted. A copy the user saved
    // from a colleague is theirs: editing it is fine, it is just no longer served.
    if (row.own === 1 && (info.size !== row.size || this.mtimeChanged(row, info.mtimeMs)))
      return 'changed';
    return 'present';
  }

  private mtimeChanged(row: FileRow, mtimeMs: number): boolean {
    return row.mtimeMs !== null && Math.abs(Math.round(mtimeMs) - row.mtimeMs) > 1;
  }

  /** Whether the bytes on disk are still the fingerprinted ones, so they may be served. */
  private servable(row: FileRow): boolean {
    const path = row.path ?? this.legacyPath(row.sha256);
    try {
      const info = statSync(path);
      return info.isFile() && info.size === row.size && !this.mtimeChanged(row, info.mtimeMs);
    } catch {
      return false;
    }
  }

  isComplete(sha: string): boolean {
    const row = this.row(sha);
    return row?.state === 'complete' && this.presence(row) !== 'gone';
  }

  /**
   * Share a local file as it is, at once: nothing is read, so a 50 GB file is ready as fast as a
   * 5 KB one. Its id is random, not a hash (see `UNHASHED_MANIFEST`), and it is served from where
   * it is for as long as it is unchanged.
   */
  async importLive(
    source: string,
    name: string,
    mime: string,
    convId: string,
    now: number,
  ): Promise<FileRef> {
    const path = resolve(source);
    const info = await stat(path);
    if (!info.isFile()) throw new Error('that is not a file');
    if (info.size > MAX_FILE_BYTES) throw new Error('that file is larger than 4 TB');
    const ref: FileRef = {
      sha256: randomBytes(32).toString('hex'),
      name,
      size: info.size,
      mime,
      manifest: UNHASHED_MANIFEST,
    };
    this.note(ref, convId, now);
    this.db
      .prepare(
        `UPDATE files SET state = 'complete', own = 1, have = NULL, path = ?, part_path = NULL,
                mtime_ms = ?, completed_at = ? WHERE sha256 = ?`,
      )
      .run(path, Math.round(info.mtimeMs), now, ref.sha256);
    return ref;
  }

  /**
   * Hash a local file in place: whole-file SHA-256 plus the SHA-256 of every 1 MB chunk
   * (the manifest). Nothing is copied; the file is read from `source` whenever it is served.
   */
  async importPath(
    source: string,
    name: string,
    mime: string,
    convId: string,
    now: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<FileRef> {
    const path = resolve(source);
    const before = await stat(path);
    if (!before.isFile()) throw new Error('that is not a file');
    if (before.size > MAX_FILE_BYTES) throw new Error('that file is larger than 4 TB');
    const whole = createHash('sha256');
    const chunkHashes: Buffer[] = [];
    let chunk = createHash('sha256');
    let inChunk = 0;
    let done = 0;
    let lastReport = 0;
    for await (const piece of createReadStream(path, {
      highWaterMark: 1024 * 1024,
    }) as AsyncIterable<Buffer>) {
      whole.update(piece);
      let offset = 0;
      while (offset < piece.length) {
        const take = Math.min(FILE_CHUNK_BYTES - inChunk, piece.length - offset);
        chunk.update(piece.subarray(offset, offset + take));
        inChunk += take;
        offset += take;
        if (inChunk === FILE_CHUNK_BYTES) {
          chunkHashes.push(chunk.digest());
          chunk = createHash('sha256');
          inChunk = 0;
        }
      }
      done += piece.length;
      if (onProgress && Date.now() - lastReport >= 200) {
        lastReport = Date.now();
        onProgress(done, before.size);
      }
    }
    if (inChunk > 0 || chunkHashes.length === 0) chunkHashes.push(chunk.digest());
    const after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('the file changed while it was being read; try again');
    onProgress?.(before.size, before.size);
    const sha = whole.digest('hex');
    const hashes = Buffer.concat(chunkHashes);
    const manifest = createHash('sha256').update(hashes).digest('hex');
    await writeFile(this.manifestPath(sha), hashes);
    const ref: FileRef = { sha256: sha, name, size: before.size, mime, manifest };
    this.note(ref, convId, now);
    this.db
      .prepare(
        `UPDATE files SET state = 'complete', own = 1, have = NULL, path = ?, part_path = NULL,
                mtime_ms = ?, completed_at = ? WHERE sha256 = ?`,
      )
      .run(path, Math.round(after.mtimeMs), now, sha);
    return ref;
  }

  /**
   * Pasted or snipped pictures have no original on disk, so these (and only these) are kept
   * in the app's folder, under `pasted/`.
   */
  async importBytes(
    bytes: Uint8Array,
    name: string,
    mime: string,
    convId: string,
    now: number,
  ): Promise<FileRef> {
    const folder = join(this.dir, 'pasted');
    await mkdir(folder, { recursive: true });
    const sha = createHash('sha256').update(bytes).digest('hex');
    const target = join(folder, `${sha.slice(0, 16)}-${safeFileName(name)}`);
    if (!existsSync(target)) await writeFile(target, bytes);
    return this.importPath(target, name, mime, convId, now);
  }

  async manifestHashes(sha: string): Promise<Buffer | undefined> {
    for (const path of [this.manifestPath(sha), `${this.legacyPath(sha)}.manifest`]) {
      try {
        return await readFile(path);
      } catch {
        // try the next location
      }
    }
    return undefined;
  }

  /** One page of the chunk list (up to `count` hashes from chunk `from`), read from disk. */
  async manifestPage(sha: string, from: number, count: number): Promise<Buffer | undefined> {
    for (const path of [this.manifestPath(sha), `${this.legacyPath(sha)}.manifest`]) {
      let fh;
      try {
        fh = await open(path, 'r');
      } catch {
        continue;
      }
      try {
        const buf = Buffer.alloc(count * 32);
        const { bytesRead } = await fh.read(buf, 0, buf.length, from * 32);
        return buf.subarray(0, bytesRead - (bytesRead % 32));
      } finally {
        await fh.close();
      }
    }
    return undefined;
  }

  /** Store a manifest after checking it against the signed `manifest` hash. */
  async setManifest(sha: string, hashes: Buffer): Promise<boolean> {
    const row = this.row(sha);
    if (!row || hashes.length !== row.chunkCount * 32) return false;
    if (createHash('sha256').update(hashes).digest('hex') !== row.manifest) return false;
    await writeFile(this.manifestPath(sha), hashes);
    return true;
  }

  /** Chunks held: `all`, a bitmap, or nothing (a changed or missing file holds nothing). */
  holding(sha: string): 'all' | Buffer | undefined {
    const row = this.row(sha);
    if (!row) return undefined;
    if (row.state === 'complete') return this.servable(row) ? 'all' : undefined;
    const have = this.haveMem.get(sha)?.bits ?? row.have;
    if (row.state === 'partial' && have && existsSync(this.partFile(row))) return have;
    return undefined;
  }

  async readChunk(sha: string, index: number): Promise<Buffer | undefined> {
    const row = this.row(sha);
    if (!row || index >= row.chunkCount) return undefined;
    const held = this.holding(sha);
    if (!held || (held !== 'all' && !bitmap.has(held, index))) return undefined;
    const file = held === 'all' ? (row.path ?? this.legacyPath(sha)) : this.partFile(row);
    const length = Math.min(FILE_CHUNK_BYTES, row.size - index * FILE_CHUNK_BYTES);
    const fh = await this.reader(file);
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, index * FILE_CHUNK_BYTES);
    // A file that shrank since it was shared holds nothing to send.
    return bytesRead === length ? buf : undefined;
  }

  /**
   * One read handle per file being served, closed once it has been idle a few seconds: opening
   * and closing a file for every megabyte is slow on Windows (each open is scanned).
   */
  private async reader(path: string): Promise<FileHandle> {
    let r = this.readers.get(path);
    if (!r) {
      const handle = open(path, 'r');
      r = { handle };
      this.readers.set(path, r);
      handle.catch(() => this.readers.delete(path));
    }
    clearTimeout(r.timer);
    r.timer = setTimeout(() => void this.closeReader(path), READER_IDLE_MS);
    r.timer.unref();
    return r.handle;
  }

  private async closeReader(path: string): Promise<void> {
    const r = this.readers.get(path);
    if (!r) return;
    this.readers.delete(path);
    clearTimeout(r.timer);
    await (await r.handle.catch(() => undefined))?.close().catch(() => {});
  }

  /** The download's part file, created in the save folder on the first chunk. */
  private async ensurePart(sha: string): Promise<string> {
    const row = this.row(sha)!;
    if (row.partPath) {
      // Chosen beforehand (a file in a folder, a folder's index): its folder may not be there yet.
      await mkdir(dirname(row.partPath), { recursive: true });
      return row.partPath;
    }
    if (existsSync(join(this.dir, `${sha}.part`))) return join(this.dir, `${sha}.part`);
    const folder = this.saveDir;
    await mkdir(folder, { recursive: true });
    const partPath = join(folder, `${safeFileName(row.name)}.${sha.slice(0, 8)}.${PART_SUFFIX}`);
    this.db.prepare('UPDATE files SET part_path = ? WHERE sha256 = ?').run(partPath, sha);
    return partPath;
  }

  private async handle(sha: string): Promise<FileHandle> {
    let h = this.handles.get(sha);
    if (!h) {
      // Cached before the first await: parallel chunks of one file must share a handle.
      h = (async () => {
        const path = await this.ensurePart(sha);
        return open(path, existsSync(path) ? 'r+' : 'w+');
      })();
      this.handles.set(sha, h);
      h.catch(() => this.handles.delete(sha));
    }
    return h;
  }

  /**
   * Verify one received chunk against the manifest (when there is one) and write it in place.
   * Returns false (and writes nothing) when the bytes do not match.
   */
  async writeChunk(
    sha: string,
    index: number,
    data: Uint8Array,
    hashes: Buffer | undefined,
  ): Promise<boolean> {
    const row = this.row(sha);
    if (!row || index >= row.chunkCount) return false;
    const expectedLength = Math.min(FILE_CHUNK_BYTES, row.size - index * FILE_CHUNK_BYTES);
    if (data.length !== expectedLength) return false;
    // A file shared without a fingerprint has no chunk list: its length is all there is to check.
    if (hashes) {
      const digest = createHash('sha256').update(data).digest();
      if (!digest.equals(hashes.subarray(index * 32, index * 32 + 32))) return false;
    }
    const fh = await this.handle(sha);
    await fh.write(data, 0, data.length, index * FILE_CHUNK_BYTES);
    const mem = this.haveMem.get(sha) ?? {
      bits: Buffer.from(row.have ?? bitmap.create(row.chunkCount)),
      flushedAt: 0,
    };
    bitmap.set(mem.bits, index);
    this.haveMem.set(sha, mem);
    if (Date.now() - mem.flushedAt >= 1_000) this.flushHave(sha);
    return true;
  }

  /** Write a download's held-chunks bitmap to the database now. */
  flushHave(sha: string): void {
    const mem = this.haveMem.get(sha);
    if (!mem) return;
    mem.flushedAt = Date.now();
    this.db
      .prepare("UPDATE files SET have = ?, state = 'partial' WHERE sha256 = ?")
      .run(mem.bits, sha);
  }

  /**
   * A part file the user deleted (or moved with its folder) cannot resume: forget what it
   * held so the download starts over instead of "finishing" a file with holes.
   */
  checkPartial(sha: string): void {
    const row = this.row(sha);
    if (!row || row.state !== 'partial') return;
    if (!existsSync(this.partFile(row)))
      this.db
        .prepare(
          "UPDATE files SET state = 'missing', have = NULL, part_path = NULL WHERE sha256 = ?",
        )
        .run(sha);
  }

  missingChunks(sha: string): number[] {
    const row = this.row(sha);
    if (!row) return [];
    if (row.state === 'complete') return [];
    const have = this.haveMem.get(sha)?.bits ?? row.have ?? bitmap.create(row.chunkCount);
    const out: number[] = [];
    for (let i = 0; i < row.chunkCount; i++) if (!bitmap.has(have, i)) out.push(i);
    return out;
  }

  /** Check the whole-file hash (or the size, for an unhashed file) and give the download its real name. */
  async finish(sha: string, now: number): Promise<boolean> {
    this.flushHave(sha);
    this.haveMem.delete(sha);
    const h = this.handles.get(sha);
    this.handles.delete(sha);
    if (h) await (await h).close();
    const row = this.row(sha)!;
    const part = this.partFile(row);
    await this.closeReader(part);
    if (!existsSync(part)) {
      // Zero-byte file: nothing was ever written.
      if (row.size !== 0) return false;
      await mkdir(dirname(part), { recursive: true });
      await writeFile(part, Buffer.alloc(0));
    }
    let intact: boolean;
    if (isUnhashed(row)) {
      // No fingerprint to check (and no minutes spent reading a big file again): the size must fit.
      intact = (await stat(part)).size === row.size;
    } else {
      const hash = createHash('sha256');
      for await (const piece of createReadStream(part, {
        highWaterMark: 4 * 1024 * 1024,
      }) as AsyncIterable<Buffer>) {
        hash.update(piece);
      }
      intact = hash.digest('hex') === sha;
    }
    if (!intact) {
      await rm(part, { force: true });
      this.db
        .prepare(
          "UPDATE files SET state = 'missing', have = NULL, part_path = NULL WHERE sha256 = ?",
        )
        .run(sha);
      return false;
    }
    const folder = dirname(part);
    const finalName = uniqueName(folder, safeFileName(row.name), existsSync);
    const finalPath = join(folder, finalName);
    await rename(part, finalPath);
    markFromAnotherComputer(finalPath);
    const { mtimeMs } = await stat(finalPath);
    this.db
      .prepare(
        `UPDATE files SET state = 'complete', own = 0, have = NULL, path = ?, part_path = NULL,
                mtime_ms = ?, completed_at = ?, wanted = 0 WHERE sha256 = ?`,
      )
      .run(finalPath, Math.round(mtimeMs), now, sha);
    return true;
  }

  /** Remember that this file is wanted (or no longer), so a restart does not forget it. */
  setWanted(sha: string, on: boolean): void {
    this.db.prepare('UPDATE files SET wanted = ? WHERE sha256 = ?').run(on ? 1 : 0, sha);
  }

  /** Files asked for and still not here, oldest first. */
  wantedFiles(limit: number): string[] {
    return this.db
      .prepare(
        "SELECT sha256 FROM files WHERE wanted = 1 AND state != 'complete' ORDER BY added_at LIMIT ?",
      )
      .pluck()
      .all(limit) as string[];
  }

  /**
   * Start over for a file whose copy is gone (deleted by the user): clear what we thought
   * we had, so it can be downloaded again.
   */
  forget(sha: string): void {
    void this.abort(sha);
    const row = this.row(sha);
    if (!row) return;
    // Synchronous, so a download started right after sees a file it must fetch.
    if (row.partPath) rmSync(row.partPath, { force: true });
    this.db
      .prepare(
        `UPDATE files SET state = 'missing', own = 0, have = NULL, path = NULL, part_path = NULL,
                mtime_ms = NULL WHERE sha256 = ?`,
      )
      .run(sha);
  }

  async abort(sha: string): Promise<void> {
    this.flushHave(sha);
    this.haveMem.delete(sha);
    const row = this.row(sha);
    if (row?.partPath) await this.closeReader(row.partPath);
    const h = this.handles.get(sha);
    this.handles.delete(sha);
    if (h) await (await h).close();
  }

  /** The path to open with the default app; the file itself, never a copy. */
  openablePath(sha: string): string {
    const row = this.row(sha);
    if (!row || row.state !== 'complete' || this.presence(row) === 'gone')
      throw new Error('file is not available on this PC');
    return row.path ?? this.legacyPath(sha);
  }

  async close(): Promise<void> {
    for (const [sha] of this.handles) await this.abort(sha);
    for (const path of [...this.readers.keys()]) await this.closeReader(path);
  }
}

export function markFromAnotherComputer(path: string): void {
  if (process.platform !== 'win32') return;
  try {
    // NTFS alternate data stream; skipped on file systems without them.
    writeFileSync(`${path}:Zone.Identifier`, ZONE_IDENTIFIER);
  } catch {
    // FAT or network drives without alternate streams
  }
}

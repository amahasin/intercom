import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  copyFile,
  type FileHandle,
} from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { FILE_CHUNK_BYTES, MAX_FILE_BYTES, type FileRef } from '@officemesh/protocol';
import { safeFileName } from './names.ts';

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
}

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

/**
 * Content-addressed files under `<dir>/<sha256>`, with `.part` files and a chunk bitmap
 * for downloads in progress and `.manifest` files holding the per-chunk SHA-256 list.
 * Names from peers are never used to build paths, except through `safeFileName` when a
 * file is opened.
 */
export class FileStore {
  readonly dir: string;
  private readonly db: Database.Database;
  private readonly handles = new Map<string, Promise<FileHandle>>();

  constructor(dir: string, db: Database.Database) {
    this.dir = dir;
    this.db = db;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  path(sha: string): string {
    return join(this.dir, sha);
  }

  private partPath(sha: string): string {
    return join(this.dir, `${sha}.part`);
  }

  private manifestPath(sha: string): string {
    return join(this.dir, `${sha}.manifest`);
  }

  row(sha: string): FileRow | undefined {
    return this.db
      .prepare(
        `SELECT sha256, name, size, mime, manifest, chunk_count AS chunkCount, state, have, own, conv_id AS convId
           FROM files WHERE sha256 = ?`,
      )
      .get(sha) as FileRow | undefined;
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
    // A file another profile on this PC already holds counts as complete.
    const row = this.row(ref.sha256)!;
    if (
      row.state !== 'complete' &&
      existsSync(this.path(ref.sha256)) &&
      existsSync(this.manifestPath(ref.sha256))
    ) {
      this.db
        .prepare("UPDATE files SET state = 'complete', completed_at = ? WHERE sha256 = ?")
        .run(now, ref.sha256);
      return this.row(ref.sha256)!;
    }
    return row;
  }

  isComplete(sha: string): boolean {
    return this.row(sha)?.state === 'complete' && existsSync(this.path(sha));
  }

  /**
   * Hash and copy a local file into the store in one pass: whole-file SHA-256 plus the
   * SHA-256 of every 1 MB chunk (the manifest).
   */
  async importPath(
    source: string,
    name: string,
    mime: string,
    convId: string,
    now: number,
  ): Promise<FileRef> {
    const { size } = await stat(source);
    if (size > MAX_FILE_BYTES) throw new Error('files are limited to 2 GB');
    const tmp = join(
      this.dir,
      `import-${process.pid}-${now}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    const out = await open(tmp, 'w');
    const whole = createHash('sha256');
    const chunkHashes: Buffer[] = [];
    let chunk = createHash('sha256');
    let inChunk = 0;
    try {
      for await (const piece of createReadStream(source, {
        highWaterMark: 1024 * 1024,
      }) as AsyncIterable<Buffer>) {
        whole.update(piece);
        await out.write(piece);
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
      }
      if (inChunk > 0 || chunkHashes.length === 0) chunkHashes.push(chunk.digest());
    } finally {
      await out.close();
    }
    const sha = whole.digest('hex');
    const hashes = Buffer.concat(chunkHashes);
    const manifest = createHash('sha256').update(hashes).digest('hex');
    if (existsSync(this.path(sha))) await rm(tmp, { force: true });
    else await rename(tmp, this.path(sha));
    await writeFile(this.manifestPath(sha), hashes);
    const ref: FileRef = { sha256: sha, name, size, mime, manifest };
    this.note(ref, convId, now);
    this.db
      .prepare(
        "UPDATE files SET state = 'complete', own = 1, have = NULL, completed_at = ? WHERE sha256 = ?",
      )
      .run(now, sha);
    return ref;
  }

  async importBytes(
    bytes: Uint8Array,
    name: string,
    mime: string,
    convId: string,
    now: number,
  ): Promise<FileRef> {
    const tmp = join(
      this.dir,
      `paste-${process.pid}-${now}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(tmp, bytes);
    try {
      return await this.importPath(tmp, name, mime, convId, now);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async manifestHashes(sha: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.manifestPath(sha));
    } catch {
      return undefined;
    }
  }

  /** Store a manifest after checking it against the signed `manifest` hash. */
  async setManifest(sha: string, hashes: Buffer): Promise<boolean> {
    const row = this.row(sha);
    if (!row || hashes.length !== row.chunkCount * 32) return false;
    if (createHash('sha256').update(hashes).digest('hex') !== row.manifest) return false;
    await writeFile(this.manifestPath(sha), hashes);
    return true;
  }

  /** Chunks held: `all`, a bitmap, or nothing. */
  holding(sha: string): 'all' | Buffer | undefined {
    const row = this.row(sha);
    if (!row) return undefined;
    if (row.state === 'complete' && existsSync(this.path(sha))) return 'all';
    if (row.state === 'partial' && row.have) return row.have;
    return undefined;
  }

  async readChunk(sha: string, index: number): Promise<Buffer | undefined> {
    const row = this.row(sha);
    if (!row || index >= row.chunkCount) return undefined;
    const held = this.holding(sha);
    if (!held || (held !== 'all' && !bitmap.has(held, index))) return undefined;
    const file = held === 'all' ? this.path(sha) : this.partPath(sha);
    const length = Math.min(FILE_CHUNK_BYTES, row.size - index * FILE_CHUNK_BYTES);
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, index * FILE_CHUNK_BYTES);
      return buf;
    } finally {
      await fh.close();
    }
  }

  private handle(sha: string): Promise<FileHandle> {
    let h = this.handles.get(sha);
    if (!h) {
      const path = this.partPath(sha);
      h = open(path, existsSync(path) ? 'r+' : 'w+');
      this.handles.set(sha, h);
    }
    return h;
  }

  /**
   * Verify one received chunk against the manifest and write it in place. Returns false
   * (and writes nothing) when the bytes do not match.
   */
  async writeChunk(sha: string, index: number, data: Uint8Array, hashes: Buffer): Promise<boolean> {
    const row = this.row(sha);
    if (!row || index >= row.chunkCount) return false;
    const expectedLength = Math.min(FILE_CHUNK_BYTES, row.size - index * FILE_CHUNK_BYTES);
    if (data.length !== expectedLength) return false;
    const digest = createHash('sha256').update(data).digest();
    if (!digest.equals(hashes.subarray(index * 32, index * 32 + 32))) return false;
    const fh = await this.handle(sha);
    await fh.write(data, 0, data.length, index * FILE_CHUNK_BYTES);
    const have = Buffer.from(this.row(sha)!.have ?? bitmap.create(row.chunkCount));
    bitmap.set(have, index);
    this.db.prepare("UPDATE files SET have = ?, state = 'partial' WHERE sha256 = ?").run(have, sha);
    return true;
  }

  missingChunks(sha: string): number[] {
    const row = this.row(sha);
    if (!row) return [];
    if (row.state === 'complete') return [];
    const have = row.have ?? bitmap.create(row.chunkCount);
    const out: number[] = [];
    for (let i = 0; i < row.chunkCount; i++) if (!bitmap.has(have, i)) out.push(i);
    return out;
  }

  /** Check the whole-file hash and move the download into place. */
  async finish(sha: string, now: number): Promise<boolean> {
    const h = this.handles.get(sha);
    this.handles.delete(sha);
    if (h) await (await h).close();
    const row = this.row(sha)!;
    const part = this.partPath(sha);
    if (!existsSync(part)) {
      // Zero-byte file: nothing was ever written.
      if (row.size !== 0) return false;
      await writeFile(part, Buffer.alloc(0));
    }
    const hash = createHash('sha256');
    for await (const piece of createReadStream(part, {
      highWaterMark: 4 * 1024 * 1024,
    }) as AsyncIterable<Buffer>) {
      hash.update(piece);
    }
    if (hash.digest('hex') !== sha) {
      await rm(part, { force: true });
      this.db.prepare("UPDATE files SET state = 'missing', have = NULL WHERE sha256 = ?").run(sha);
      return false;
    }
    await rename(part, this.path(sha));
    markFromAnotherComputer(this.path(sha));
    this.db
      .prepare(
        "UPDATE files SET state = 'complete', have = NULL, completed_at = ? WHERE sha256 = ?",
      )
      .run(now, sha);
    return true;
  }

  async abort(sha: string): Promise<void> {
    const h = this.handles.get(sha);
    this.handles.delete(sha);
    if (h) await (await h).close();
  }

  /**
   * A named copy to open with the default app: a hard link (or copy) under
   * `<dir>/open/<sha8>/<safe name>`, carrying the "from another computer" zone.
   */
  async openablePath(sha: string): Promise<string> {
    const row = this.row(sha);
    if (!row || !this.isComplete(sha)) throw new Error('file is not available on this PC');
    const folder = join(this.dir, 'open', sha.slice(0, 16));
    await mkdir(folder, { recursive: true });
    const target = join(folder, safeFileName(row.name));
    if (!existsSync(target)) {
      try {
        await link(this.path(sha), target);
      } catch {
        await copyFile(this.path(sha), target);
      }
      if (!row.own) markFromAnotherComputer(target);
    }
    return target;
  }

  async close(): Promise<void> {
    for (const [sha] of this.handles) await this.abort(sha);
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

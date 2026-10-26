/**
 * Folders, sent the way a LAN messenger would: as the tree they are, not packed into anything.
 *
 * The sender's side. Sending a folder walks it and shares every file in it as it is (each is
 * served from where it is, like any file: nothing is read, copied or packed first, and a file can
 * be any size a file can be). What goes in the message is the folder's index: one line for each
 * folder and file, with the id each file is shared under. Nothing limits how big the folder is;
 * only a million entries in one (a guard for the receiving PC, see `MAX_FOLDER_ENTRIES`).
 *
 * The receiving side (`FolderManager`). It fetches the index (a file like any other), makes the
 * folders, and fetches the files into them a few at a time, each by the usual file transfer
 * (chunks, resuming, and the speed of the LAN), while the card in the chat shows the folder as one
 * transfer: files and bytes done, speed, time left. A file that was not there when its turn came
 * (the sender went offline) waits for them; a restart carries on where it was. Nothing in the
 * index is trusted: names are made safe and must land inside the folder, sizes and ids are
 * checked, and the number of entries is bounded.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { lstat, mkdir, opendir, rm, statfs } from 'node:fs/promises';
import { once } from 'node:events';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  FOLDER_MIME,
  FolderIndexLine,
  MAX_FOLDER_ENTRIES,
  UNHASHED_MANIFEST,
  type FileRef,
} from '@officemesh/protocol';
import type { FileStatus, FileUpload } from '@officemesh/protocol/ipc';
import type Database from 'better-sqlite3';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';
import type { FileRow, FileStore } from './store.ts';
import { Meter, PROGRESS_EVERY_MS, UPLOAD_IDLE_MS, type TransferManager } from './transfer.ts';

/** Files fetched at the same time (each is chunks in flight already; this is for the many small ones). */
const FILES_AT_ONCE = 6;
/**
 * Files started in one second, at most: each costs the sender one chunk request, and a link allows
 * a few hundred of those a second before it is taken for abuse (`LINK_LIMITS`).
 */
const START_PER_SECOND = 150;
/** A file that did not arrive right is fetched again this many times before it is given up. */
const RETRIES = 3;
/** Rows are written to the database this many at a time. */
const BATCH = 500;
/** A path longer than this is not made (Windows' limit is 260). */
const MAX_PATH_CHARS = 240;

export class FolderTooBig extends Error {}

/** Names Windows does not allow for a file, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A name from an index as segments of a path inside the folder, or undefined when it is not a
 * name to take (it climbs out with "..", names a drive or a data stream, is empty).
 */
export function safeSegments(name: string): string[] | undefined {
  if (name.includes('\0')) return undefined;
  const out: string[] = [];
  for (const raw of name.split(/[\\/]/)) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..' || raw.includes(':')) return undefined;
    // eslint-disable-next-line no-control-regex
    let seg = raw.replace(/[<>"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
    if (seg === '') return undefined;
    if (RESERVED.test(seg)) seg = `_${seg}`;
    if (seg.length > 200) return undefined;
    out.push(seg);
  }
  return out.length > 0 ? out : undefined;
}

/** A name for the folder being received: `Reports`, else `Reports (2)`, ... */
export function freeFolder(parent: string, wanted: string): string {
  const base = safeSegments(wanted)?.[0] ?? 'Folder';
  for (let n = 1; n < 1000; n++) {
    const candidate = join(parent, n === 1 ? base : `${base} (${n})`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(parent, `${base} (${Date.now()})`);
}

// ---------------------------------------------------------------------------
// The sender's side
// ---------------------------------------------------------------------------

interface Found {
  rel: string;
  full: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}

/** Everything under `root`, depth first, one at a time; links are never followed. */
async function* walk(
  root: string,
  rel: string,
  depth: number,
  skipped: { n: number },
): AsyncGenerator<Found> {
  if (depth > 64) {
    skipped.n += 1;
    return;
  }
  let dir;
  try {
    dir = await opendir(join(root, rel));
  } catch {
    skipped.n += 1;
    return;
  }
  for await (const entry of dir) {
    const name = entry.name;
    const childRel = rel ? `${rel}/${name}` : name;
    const full = join(root, childRel);
    let info;
    try {
      // lstat: a link (symbolic, or a junction) is not followed, so a folder cannot be made to
      // hold what is elsewhere, or itself.
      info = await lstat(full);
    } catch {
      skipped.n += 1;
      continue;
    }
    if (info.isSymbolicLink()) {
      skipped.n += 1;
    } else if (info.isDirectory()) {
      yield { rel: childRel, full, dir: true, size: 0, mtimeMs: info.mtimeMs };
      yield* walk(root, childRel, depth + 1, skipped);
    } else if (info.isFile()) {
      yield { rel: childRel, full, dir: false, size: info.size, mtimeMs: info.mtimeMs };
    } else {
      skipped.n += 1;
    }
  }
}

export interface SharedFolder {
  files: number;
  folders: number;
  bytes: number;
  /** Things left out: links, and what could not be read. */
  skipped: number;
  /** The files of the folder carry this until the index has an id (see `FileStore.retagFolder`). */
  tag: string;
}

/**
 * Share every file in `source` as it is and write the folder's index to `indexPath`. Throws (and
 * leaves nothing behind) when the folder holds more than `MAX_FOLDER_ENTRIES`.
 */
export async function shareFolderTree(options: {
  store: FileStore;
  source: string;
  indexPath: string;
  convId: string;
  now: number;
}): Promise<SharedFolder> {
  const { store, convId, now } = options;
  const root = resolve(options.source);
  const tag = `pending:${randomBytes(8).toString('hex')}`;
  await mkdir(dirname(options.indexPath), { recursive: true });
  const out = createWriteStream(options.indexPath);
  const result: SharedFolder = { files: 0, folders: 0, bytes: 0, skipped: 0, tag };
  const skipped = { n: 0 };
  let batch: Found[] = [];
  let entries = 0;
  const line = async (value: object): Promise<void> => {
    if (!out.write(`${JSON.stringify(value)}\n`)) await once(out, 'drain');
  };
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const ids = store.importLiveBatch(
      batch.map((f) => ({
        path: f.full,
        name: basename(f.full),
        size: f.size,
        mtimeMs: f.mtimeMs,
      })),
      convId,
      tag,
      now,
    );
    for (const [i, f] of batch.entries()) {
      await line({ f: f.rel, s: f.size, i: ids[i] });
      result.files += 1;
      result.bytes += f.size;
    }
    batch = [];
  };
  try {
    for await (const found of walk(root, '', 0, skipped)) {
      if (++entries > MAX_FOLDER_ENTRIES)
        throw new FolderTooBig(
          `That folder holds more than ${MAX_FOLDER_ENTRIES.toLocaleString('en-US')} files and folders. Send it in parts.`,
        );
      if (found.dir) {
        await line({ d: found.rel });
        result.folders += 1;
      } else {
        batch.push(found);
        if (batch.length >= BATCH) await flush();
      }
    }
    await flush();
    await new Promise<void>((done, fail) => {
      out.once('error', fail);
      out.end(done);
    });
    result.skipped = skipped.n;
    return result;
  } catch (err) {
    out.destroy();
    store.dropFolderFiles(tag);
    await rm(options.indexPath, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The receiving side
// ---------------------------------------------------------------------------

interface Xfer {
  indexSha: string;
  convId: string;
  name: string;
  root: string;
  files: number;
  bytes: number;
  state: 'running' | 'complete' | 'cancelled' | 'failed';
  error: string | undefined;
  /** Files being fetched now. */
  active: Set<string>;
  doneFiles: number;
  doneBytes: number;
  failedFiles: number;
  retries: Map<string, number>;
  /** Where the next file to start is looked for (rows are taken in the order they were made). */
  cursor: number;
  /** The recent speed, from what had arrived at each tick. */
  lastReceived: number;
  lastAt: number;
  rate: number | undefined;
  last: FileStatus;
}

interface XferRow {
  indexSha: string;
  convId: string;
  name: string;
  root: string;
  files: number;
  bytes: number;
  state: Xfer['state'];
  error: string | null;
}

export interface FolderManagerOptions {
  store: FileStore;
  db: Database.Database;
  transfers: () => TransferManager | undefined;
  clock: Clock;
  logger: Logger;
  saveDir: () => string;
  progress: (status: FileStatus) => void;
}

export class FolderManager {
  private readonly o: FolderManagerOptions;
  private readonly xfers = new Map<string, Xfer>();
  private readonly starting = new Set<string>();
  /** Folders whose index was here but that could not be made (not enough room, say), and why. */
  private readonly notStarted = new Map<string, string>();
  private tick: TimerHandle | undefined;
  private startedAt = 0;
  private started = 0;

  constructor(options: FolderManagerOptions) {
    this.o = options;
    this.tick = options.clock.setInterval(() => this.onTick(), 1_000);
  }

  stop(): void {
    if (this.tick) this.o.clock.clearInterval(this.tick);
  }

  /** Whether the file with this id is the index of a folder (or a file in one) this PC is getting. */
  has(indexSha: string): boolean {
    return this.xfers.has(indexSha) || this.rowOf(indexSha) !== undefined;
  }

  /** The bytes in all the files of the folder, if this PC is getting it. */
  bytesOf(indexSha: string): number | undefined {
    return this.xfers.get(indexSha)?.bytes ?? this.rowOf(indexSha)?.bytes;
  }

  /** Where the folder is being (or was) made on this PC. */
  rootOf(indexSha: string): string | undefined {
    return this.xfers.get(indexSha)?.root ?? this.rowOf(indexSha)?.root;
  }

  private rowOf(indexSha: string): XferRow | undefined {
    return this.o.db
      .prepare(
        `SELECT index_sha AS indexSha, conv_id AS convId, name, root, files, bytes, state, error
           FROM folder_xfers WHERE index_sha = ?`,
      )
      .get(indexSha) as XferRow | undefined;
  }

  private save(x: Xfer): void {
    this.o.db
      .prepare(
        `INSERT INTO folder_xfers (index_sha, conv_id, name, root, files, bytes, started_at, state, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (index_sha) DO UPDATE SET files = excluded.files, bytes = excluded.bytes,
           state = excluded.state, error = excluded.error, root = excluded.root`,
      )
      .run(
        x.indexSha,
        x.convId,
        x.name,
        x.root,
        x.files,
        x.bytes,
        this.o.clock.now(),
        x.state,
        x.error ?? null,
      );
  }

  /** The folder as one transfer, or undefined when this PC has not started getting it. */
  status(indexSha: string): FileStatus | undefined {
    const x = this.load(indexSha);
    if (!x) {
      // The index is here but the folder is not made yet (the index is being read): the folder is
      // coming, not complete, whatever the index file itself says.
      const row = this.o.store.row(indexSha);
      if (row?.mime !== FOLDER_MIME || row.own === 1 || row.state !== 'complete') return undefined;
      const error = this.notStarted.get(indexSha);
      return error
        ? { sha256: indexSha, state: 'failed', received: 0, size: 0, error }
        : { sha256: indexSha, state: 'downloading', received: 0, size: 0 };
    }
    switch (x.state) {
      case 'complete':
        return existsSync(x.root)
          ? { sha256: indexSha, state: 'complete', received: x.bytes, size: x.bytes }
          : {
              sha256: indexSha,
              state: 'gone',
              received: 0,
              size: x.bytes,
              error: 'The folder was moved or deleted.',
            };
      case 'failed':
        return {
          sha256: indexSha,
          state: 'failed',
          received: 0,
          size: x.bytes,
          ...(x.error && { error: x.error }),
        };
      case 'cancelled':
        return { sha256: indexSha, state: 'missing', received: 0, size: x.bytes };
      default:
        return x.last;
    }
  }

  /** The folder's state, from memory or (after a restart) from the database. */
  private load(indexSha: string): Xfer | undefined {
    const known = this.xfers.get(indexSha);
    if (known) return known;
    const row = this.rowOf(indexSha);
    if (!row) return undefined;
    const x = this.make(row);
    this.xfers.set(indexSha, x);
    return x;
  }

  private make(row: XferRow): Xfer {
    const sums = this.o.db
      .prepare(
        "SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM files WHERE folder_sha = ? AND state = 'complete'",
      )
      .get(row.indexSha) as { n: number; b: number };
    const active = this.o.db
      .prepare(
        "SELECT sha256 FROM files WHERE folder_sha = ? AND wanted = 1 AND state != 'complete'",
      )
      .pluck()
      .all(row.indexSha) as string[];
    return {
      indexSha: row.indexSha,
      convId: row.convId,
      name: row.name,
      root: row.root,
      files: row.files,
      bytes: row.bytes,
      state: row.state,
      error: row.error ?? undefined,
      active: new Set(active),
      doneFiles: sums.n,
      doneBytes: sums.b,
      failedFiles: 0,
      retries: new Map(),
      cursor: 0,
      lastReceived: sums.b,
      lastAt: this.o.clock.now(),
      rate: undefined,
      last: {
        sha256: row.indexSha,
        state: 'downloading',
        received: sums.b,
        size: row.bytes,
      },
    };
  }

  /** Pick up folders that were being received when the app last closed. */
  resume(): void {
    const rows = this.o.db
      .prepare(
        `SELECT index_sha AS indexSha, conv_id AS convId, name, root, files, bytes, state, error
           FROM folder_xfers WHERE state = 'running'`,
      )
      .all() as XferRow[];
    for (const row of rows) {
      const x = this.load(row.indexSha);
      if (x) this.pump(x);
    }
    // An index that arrived but whose folder was not made before the app closed.
    const unmade = this.o.db
      .prepare(
        `SELECT sha256 FROM files f WHERE mime = ? AND own = 0 AND state = 'complete'
            AND NOT EXISTS (SELECT 1 FROM folder_xfers WHERE index_sha = f.sha256)`,
      )
      .pluck()
      .all(FOLDER_MIME) as string[];
    for (const sha of unmade) {
      const row = this.o.store.row(sha);
      if (row) void this.begin(sha, row);
    }
  }

  /** Start (or carry on) getting a folder, whose index is the file `indexSha`. */
  fetch(indexSha: string): FileStatus {
    const row = this.o.store.row(indexSha);
    const transfers = this.o.transfers();
    if (!row || !transfers) throw new Error('unknown folder');
    this.notStarted.delete(indexSha);
    const x = this.load(indexSha);
    if (x) {
      // Deleted by the user: made again from the start.
      if (x.state === 'complete' && !existsSync(x.root)) this.reset(x);
      else if (x.state === 'cancelled' || x.state === 'failed') {
        x.state = 'running';
        delete x.error;
        x.failedFiles = 0;
        x.retries.clear();
        x.cursor = 0;
        this.save(x);
        this.pump(x);
        this.emit(x);
        return x.last;
      } else return this.status(indexSha)!;
    }
    if (row.state !== 'complete') {
      // The index first; when it is here the folder starts (`onCompleted`).
      return transfers.download(refOf(row));
    }
    void this.begin(indexSha, row);
    return { sha256: indexSha, state: 'downloading', received: 0, size: 0 };
  }

  private reset(x: Xfer): void {
    this.xfers.delete(x.indexSha);
    this.o.store.purgeFolder(x.indexSha);
    this.o.db.prepare('DELETE FROM folder_xfers WHERE index_sha = ?').run(x.indexSha);
    this.o.db.prepare('DELETE FROM files WHERE folder_sha = ? AND own = 0').run(x.indexSha);
  }

  /** A file finished downloading: the index of a folder (start it), or a file in one (count it). */
  onCompleted(sha: string): void {
    const row = this.o.store.row(sha);
    if (!row) return;
    if (row.folderSha) {
      const x = this.load(row.folderSha);
      if (!x || x.state !== 'running' || !x.active.delete(sha)) return;
      x.doneFiles += 1;
      x.doneBytes += row.size;
      this.pump(x);
      return;
    }
    if (row.mime === FOLDER_MIME && !this.has(sha)) void this.begin(sha, row);
  }

  /** Make the folder from its index and start fetching the files. */
  private async begin(indexSha: string, row: FileRow): Promise<void> {
    if (this.starting.has(indexSha)) return;
    this.starting.add(indexSha);
    try {
      const index = this.o.store.openablePath(indexSha);
      // One pass to learn what is coming (and refuse what cannot fit), one to make it.
      let files = 0;
      let bytes = 0;
      for await (const entry of readIndex(index)) {
        if (!('f' in entry)) continue;
        files += 1;
        bytes += entry.s;
        if (files > MAX_FOLDER_ENTRIES) throw new Error('this folder holds too many files');
      }
      const space = await statfs(this.o.saveDir()).catch(() => undefined);
      if (space) {
        const free = Number(space.bavail) * Number(space.bsize);
        if (free < bytes + 256 * 1024 * 1024)
          throw new Error(
            `Not enough free space in ${this.o.saveDir()}: ${(bytes / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free.`,
          );
      }
      await mkdir(this.o.saveDir(), { recursive: true });
      const root = freeFolder(this.o.saveDir(), row.name);
      await mkdir(root, { recursive: true });
      const convId = row.convId ?? '';
      const made = new Set<string>([root]);
      let pending: Array<{ ref: FileRef; partPath: string }> = [];
      let accepted = 0;
      let acceptedBytes = 0;
      const now = this.o.clock.now();
      const writeBatch = (): void => {
        if (pending.length === 0) return;
        this.o.store.noteFolderFiles(pending, convId, indexSha, now);
        pending = [];
      };
      for await (const entry of readIndex(index)) {
        const rel = 'd' in entry ? entry.d : entry.f;
        const segments = safeSegments(rel);
        const place = segments && resolve(root, ...segments);
        // Inside the folder, whatever the index said: the one check every name goes through.
        if (!place || !place.startsWith(root + sep) || place.length > MAX_PATH_CHARS) continue;
        if ('d' in entry) {
          await mkdir(place, { recursive: true });
          continue;
        }
        const parent = dirname(place);
        if (!made.has(parent)) {
          await mkdir(parent, { recursive: true });
          made.add(parent);
        }
        const name = basename(place);
        pending.push({
          ref: {
            sha256: entry.i,
            name,
            size: entry.s,
            mime: 'application/octet-stream',
            manifest: UNHASHED_MANIFEST,
          },
          partPath: join(parent, `${name}.${entry.i.slice(0, 8)}.officemesh-part`),
        });
        accepted += 1;
        acceptedBytes += entry.s;
        if (pending.length >= BATCH) writeBatch();
      }
      writeBatch();
      const x = this.make({
        indexSha,
        convId,
        name: row.name,
        root,
        files: accepted,
        bytes: acceptedBytes,
        state: 'running',
        error: null,
      });
      this.xfers.set(indexSha, x);
      this.save(x);
      if (accepted === 0) this.finishIfDone(x);
      else this.pump(x);
      this.emit(x);
    } catch (err) {
      this.o.logger.warn('could not start a folder', { err: String(err) });
      const error = err instanceof Error ? err.message : String(err);
      this.notStarted.set(indexSha, error);
      this.o.progress({ sha256: indexSha, state: 'failed', received: 0, size: 0, error });
    } finally {
      this.starting.delete(indexSha);
    }
  }

  /** Start the next files until there are enough going. */
  private pump(x: Xfer): void {
    const transfers = this.o.transfers();
    if (!transfers || x.state !== 'running') return;
    const next = this.o.db.prepare(
      `SELECT rowid AS id, sha256, name, size, mime, manifest FROM files
        WHERE folder_sha = ? AND state != 'complete' AND wanted = 0 AND rowid > ?
        ORDER BY rowid LIMIT 1`,
    );
    const now = this.o.clock.now();
    if (now - this.startedAt >= 1_000) {
      this.startedAt = now;
      this.started = 0;
    }
    while (x.active.size < FILES_AT_ONCE && this.started < START_PER_SECOND) {
      const row = next.get(x.indexSha, x.cursor) as
        | { id: number; sha256: string; name: string; size: number; mime: string; manifest: string }
        | undefined;
      if (!row) break;
      x.cursor = row.id;
      x.active.add(row.sha256);
      this.started += 1;
      try {
        transfers.download(
          {
            sha256: row.sha256,
            name: row.name,
            size: row.size,
            mime: row.mime,
            manifest: row.manifest,
          },
          { assumeHeld: true },
        );
      } catch (err) {
        x.active.delete(row.sha256);
        x.failedFiles += 1;
        this.o.logger.warn('a file of a folder could not be started', { err: String(err) });
      }
    }
    this.finishIfDone(x);
  }

  /** Nothing left to start and nothing going: the folder is complete (or says what failed). */
  private finishIfDone(x: Xfer): void {
    if (x.state !== 'running' || x.active.size > 0) return;
    const left = this.o.db
      .prepare(
        "SELECT 1 FROM files WHERE folder_sha = ? AND state != 'complete' AND wanted = 0 AND rowid > ? LIMIT 1",
      )
      .get(x.indexSha, x.cursor);
    if (left) return;
    if (x.failedFiles > 0) {
      x.state = 'failed';
      x.error = `${x.failedFiles} ${x.failedFiles === 1 ? 'file' : 'files'} could not be received.`;
    } else x.state = 'complete';
    this.save(x);
    this.emit(x);
  }

  async cancel(indexSha: string): Promise<FileStatus> {
    const transfers = this.o.transfers();
    const x = this.load(indexSha);
    if (x && x.state === 'running') {
      x.state = 'cancelled';
      for (const sha of [...x.active]) await transfers?.cancel(sha).catch(() => {});
      x.active.clear();
      this.save(x);
      this.emit(x);
    } else if (transfers) {
      await transfers.cancel(indexSha);
    }
    return this.status(indexSha) ?? { sha256: indexSha, state: 'missing', received: 0, size: 0 };
  }

  private compute(x: Xfer): FileStatus {
    const transfers = this.o.transfers();
    let received = x.doneBytes;
    let waiting = 0;
    let failure: string | undefined;
    for (const sha of [...x.active]) {
      const st = transfers?.status(sha);
      if (!st) continue;
      if (st.state === 'complete') {
        // Done while no one was looking.
        x.active.delete(sha);
        const size = st.size;
        x.doneFiles += 1;
        x.doneBytes += size;
        received += size;
        continue;
      }
      received += st.received;
      if (st.state === 'unavailable') waiting += 1;
      else if (st.state === 'failed') failure = st.error ?? 'A file could not be received.';
      else if (st.state === 'missing') {
        // Its job is gone without the file (it did not check out): try again, then give up on it.
        const tries = (x.retries.get(sha) ?? 0) + 1;
        x.retries.set(sha, tries);
        const row = this.o.store.row(sha);
        if (row && tries <= RETRIES) transfers?.download(refOf(row));
        else {
          x.active.delete(sha);
          x.failedFiles += 1;
          transfers?.cancel(sha).catch(() => {});
        }
      }
    }
    const now = this.o.clock.now();
    const dt = now - x.lastAt;
    if (dt >= 900) {
      const instant = ((received - x.lastReceived) * 1000) / dt;
      x.rate = x.rate === undefined ? instant : x.rate * 0.6 + instant * 0.4;
      x.lastReceived = received;
      x.lastAt = now;
    }
    if (failure) {
      x.state = 'failed';
      x.error = failure;
      for (const sha of x.active) transfers?.cancel(sha).catch(() => {});
      x.active.clear();
      this.save(x);
      return { sha256: x.indexSha, state: 'failed', received, size: x.bytes, error: failure };
    }
    const stalled = x.active.size > 0 && waiting === x.active.size;
    const rate = x.rate;
    return {
      sha256: x.indexSha,
      state: stalled ? 'unavailable' : 'downloading',
      received: Math.min(received, x.bytes),
      size: x.bytes,
      ...(!stalled &&
        rate !== undefined && {
          bytesPerSecond: Math.max(0, Math.round(rate)),
          etaSeconds: rate > 1 ? Math.ceil(Math.max(0, x.bytes - received) / rate) : null,
        }),
    };
  }

  private emit(x: Xfer): void {
    if (x.state === 'running') x.last = this.compute(x);
    this.o.progress(this.status(x.indexSha) ?? x.last);
  }

  private onTick(): void {
    for (const x of this.xfers.values()) {
      if (x.state !== 'running') continue;
      try {
        this.emit(x);
        if (x.state === 'running') this.pump(x);
      } catch (err) {
        // The database is closing (the app is quitting), or a file's row is gone: the next tick tries again.
        this.o.logger.debug('folder tick failed', { err: String(err) });
      }
    }
  }
}

function refOf(row: FileRow): FileRef {
  return {
    sha256: row.sha256,
    name: row.name,
    size: row.size,
    mime: row.mime,
    manifest: row.manifest,
  };
}

/** The lines of an index that make sense, one at a time (the rest are skipped). */
async function* readIndex(path: string): AsyncGenerator<FolderIndexLine> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const text of lines) {
      if (!text) continue;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      const line = FolderIndexLine.safeParse(value);
      if (!line.success) continue;
      // Far past what any folder holds: the rest of the file is not read.
      if (++count > MAX_FOLDER_ENTRIES + 1) return;
      yield line.data;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Sending: the folder's card shows it going out
// ---------------------------------------------------------------------------------------------

export interface FolderUploadsOptions {
  clock: Clock;
  /** The size of one file in a folder. */
  sizeOf(sha: string): number | undefined;
  /** The bytes in the whole folder. */
  totalOf(folderSha: string): number;
  /** Who is being sent the folder, as it is shown on its card (the same as for a single file). */
  emit(folderSha: string, uploads: FileUpload[]): void;
}

/** What one colleague has been sent of one folder. */
interface Sending {
  /** Bytes of the files that are done. */
  finished: number;
  /** The files in the middle of being sent: how much of each is there (counting what they had), and how much went now. */
  partial: Map<string, { done: number; sent: number }>;
  partialBytes: number;
  lastAt: number;
  meter: Meter;
}

/**
 * The files of a folder are sent one by one, each under its own id (which nothing on screen knows),
 * so the sender's card for the folder had nothing to show. This adds them up: for each colleague,
 * everything sent of the folder so far out of everything in it, with the speed and the time left,
 * reported under the folder's id (what the card looks at) as it is for a single file. Fed with
 * what the transfers report for each file; a colleague that nothing has been sent for a few
 * seconds has what they came for, and is dropped, which clears the card.
 */
export class FolderUploads {
  private readonly folders = new Map<
    string,
    {
      total: number;
      users: Map<string, Sending>;
      lastEmit: number;
      /** Files finished in the last few seconds: their last report must not count them twice. */
      recent: Map<string, number>;
    }
  >();

  private readonly o: FolderUploadsOptions;

  constructor(options: FolderUploadsOptions) {
    this.o = options;
  }

  /** A file of `folderSha` reports who it is being sent to (what a transfer says for any file). */
  note(folderSha: string, fileSha: string, uploads: FileUpload[]): void {
    const now = this.o.clock.now();
    let folder = this.folders.get(folderSha);
    if (!folder) {
      folder = {
        total: Math.max(1, this.o.totalOf(folderSha)),
        users: new Map(),
        lastEmit: 0,
        recent: new Map(),
      };
      this.folders.set(folderSha, folder);
    }
    for (const [id, at] of folder.recent)
      if (now - at > 2 * UPLOAD_IDLE_MS) folder.recent.delete(id);
    const size = this.o.sizeOf(fileSha) ?? 0;
    let changed = false;
    const named = new Set<string>();
    for (const u of uploads) {
      named.add(u.userId);
      let user = folder.users.get(u.userId);
      if (!user) {
        user = {
          finished: 0,
          partial: new Map(),
          partialBytes: 0,
          lastAt: now,
          meter: new Meter(),
        };
        folder.users.set(u.userId, user);
        changed = true;
      }
      user.lastAt = now;
      if (folder.recent.has(fileSha)) continue;
      // What this file has got to: what they already had (resumed) and what has gone now.
      const done = Math.min(size, Math.max(0, size - u.total) + u.sent);
      const before = user.partial.get(fileSha) ?? { done: 0, sent: 0 };
      const moved = Math.max(0, u.sent - before.sent);
      if (moved > 0) user.meter.add(now, moved);
      if (size > 0 && done >= size) {
        user.finished += size;
        user.partialBytes -= before.done;
        user.partial.delete(fileSha);
        folder.recent.set(fileSha, now);
      } else {
        const best = Math.max(done, before.done);
        user.partialBytes += best - before.done;
        user.partial.set(fileSha, { done: best, sent: Math.max(u.sent, before.sent) });
      }
    }
    // Nothing for a few seconds from any of its files: they have everything they came for.
    for (const [id, user] of folder.users) {
      if (!named.has(id) && now - user.lastAt >= UPLOAD_IDLE_MS) {
        folder.users.delete(id);
        changed = true;
      }
    }
    const list = this.list(folder, now);
    const complete = list.some((u) => u.sent >= u.total);
    if (changed || complete || now - folder.lastEmit >= PROGRESS_EVERY_MS) {
      folder.lastEmit = now;
      this.o.emit(folderSha, list);
    }
    if (folder.users.size === 0) this.folders.delete(folderSha);
  }

  private list(folder: { total: number; users: Map<string, Sending> }, now: number): FileUpload[] {
    return [...folder.users].map(([userId, user]) => {
      const sent = Math.min(folder.total, user.finished + user.partialBytes);
      const rate = user.meter.rate(now);
      return {
        userId,
        sent,
        total: folder.total,
        bytesPerSecond: Math.round(rate ?? 0),
        etaSeconds: rate !== undefined && rate > 0 ? Math.ceil((folder.total - sent) / rate) : null,
      };
    });
  }
}

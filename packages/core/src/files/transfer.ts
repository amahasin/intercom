import {
  BINARY_FRAME_HEADER_BYTES,
  decodeBase64Url,
  encodeBase64Url,
  FILE_CHUNK_BYTES,
  FileCancelBody,
  FileHaveBody,
  FileManifestBody,
  FileRequestBody,
  LINK_LIMITS,
  MAX_CHUNKS_PER_REQUEST,
  type FileRef,
  MAX_HAVE_BITMAP_BYTES,
  MANIFEST_PAGE_CHUNKS,
} from '@officemesh/protocol';
import { statfs } from 'node:fs/promises';
import type { FileStatus, FileUpload } from '@officemesh/protocol/ipc';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';
import type { LinkManager } from '../link/link-manager.ts';
import { bitmap, isUnhashed, type FileStore } from './store.ts';

/**
 * Up to 32 chunks in flight per holder, refilled once half have arrived, in requests of
 * 16 chunks (16 MB). That keeps requests near 13 per second even at 200 MB/s, well inside
 * the link's 50-text-frames-per-second abuse limit (a request per chunk tripped it).
 */
const PER_HOLDER_INFLIGHT = 32;
/** Chunks read from disk ahead of the one being sent. */
const READ_AHEAD = 4;
const REFILL_BELOW = PER_HOLDER_INFLIGHT / 2;
const TOTAL_INFLIGHT = 64;
const CHUNK_TIMEOUT_MS = 20_000;
const MAX_STRIKES = 3;
const PROGRESS_EVERY_MS = 250;
/** Re-ask holders of a stalled download this often (dialing still follows link backoff). */
const UNAVAILABLE_RETRY_MS = 5_000;
/** Speed is the average over this long, so the figure (and the ETA) does not jump around. */
const SPEED_WINDOW_MS = 4_000;
/** An upload with no requests for this long is over. */
const UPLOAD_IDLE_MS = 3_000;

/** Bytes moved over time, for a speed and an ETA. */
export class Meter {
  private samples: Array<{ at: number; bytes: number }> = [];

  add(at: number, bytes: number): void {
    this.samples.push({ at, bytes });
    const cutoff = at - SPEED_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1]!.at < cutoff) this.samples.shift();
  }

  /** Bytes a second over the window, or undefined until there is enough to say. */
  rate(now: number): number | undefined {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || this.samples.length < 2) return undefined;
    // Stop counting when it has gone quiet: a stalled transfer reads 0, not its last speed.
    if (now - last.at > 2_000) return 0;
    const span = last.at - first.at;
    if (span < 400) return undefined;
    const bytes = this.samples.slice(1).reduce((n, s) => n + s.bytes, 0);
    return (bytes * 1000) / span;
  }
}

interface Upload {
  userId: string;
  size: number;
  /** What the peer held when this upload started (bytes). */
  base: number;
  sent: number;
  lastAt: number;
  meter: Meter;
}

interface Holder {
  userId: string;
  /** Chunks it says it holds; `all` when complete. */
  chunks: 'all' | Uint8Array | undefined;
  queried: boolean;
  strikes: number;
  inflight: number;
}

interface Job {
  sha: string;
  size: number;
  chunkCount: number;
  missing: Set<number>;
  inflight: Map<number, { holder: string; at: number }>;
  holders: Map<string, Holder>;
  hashes: Buffer | undefined;
  /** Shared as it is, with no chunk list to check against (see `UNHASHED_MANIFEST`). */
  live: boolean;
  state: 'downloading' | 'unavailable' | 'failed';
  error?: string;
  received: number;
  meter: Meter;
  lastProgress: number;
  finishing: boolean;
  lastPump: number;
}

export interface TransferOptions {
  store: FileStore;
  links: LinkManager;
  clock: Clock;
  logger: Logger;
  selfId: string;
  /** Members (other than this PC) of the conversation a file was shared in. */
  membersFor(sha: string): string[];
  /** Whether a peer may fetch this file from us (member of its conversation). */
  mayServe(sha: string, userId: string): boolean;
  isOnline(userId: string): boolean;
  dial(userId: string): void;
  progress(status: FileStatus): void;
  /** Who this PC is sending a file to right now, and how far along they are. */
  uploads(sha: string, uploads: FileUpload[]): void;
  completed(sha: string): void;
}

/** Transfer IDs are the first 16 bytes of the file's SHA-256. */
function transferId(sha: string): Buffer {
  return Buffer.from(sha.slice(0, 32), 'hex');
}

/**
 * Chunked peer-to-peer file transfer. Downloads pull 1 MB chunks from every member who
 * holds them, verify each against the signed manifest (a file shared as it is has none and comes
 * from its sender), resume after interruptions, and answer other members' requests for anything
 * this PC holds.
 */
export class TransferManager {
  private readonly o: TransferOptions;
  private readonly jobs = new Map<string, Job>();
  private readonly byTransferId = new Map<string, string>();
  private readonly serving = new Map<string, number>();
  private readonly uploads = new Map<string, Map<string, Upload>>();
  private readonly lastUploadEmit = new Map<string, number>();
  private tick: TimerHandle | undefined;
  private stopped = false;

  constructor(options: TransferOptions) {
    this.o = options;
    const { links } = options;
    links.on('file.have', (from, body) => {
      const req = FileHaveBody.parse(body);
      if (req.have) return; // a reply that arrived after its request timed out
      if (!this.o.mayServe(req.sha256, from))
        return { type: 'file.have', body: { sha256: req.sha256, have: 'none' } };
      const held = this.o.store.holding(req.sha256);
      if (held === 'all') return { type: 'file.have', body: { sha256: req.sha256, have: 'all' } };
      // The bitmap of a huge partial file would not fit a frame: such a file is served only whole.
      if (held && held.length <= MAX_HAVE_BITMAP_BYTES)
        return {
          type: 'file.have',
          body: { sha256: req.sha256, have: 'partial', chunks: encodeBase64Url(held) },
        };
      return { type: 'file.have', body: { sha256: req.sha256, have: 'none' } };
    });
    links.on('file.manifest', async (from, body) => {
      const req = FileManifestBody.parse(body);
      if (req.hashes || !this.o.mayServe(req.sha256, from)) return;
      const first = req.from ?? 0;
      const hashes = await this.o.store.manifestPage(req.sha256, first, MANIFEST_PAGE_CHUNKS);
      if (hashes)
        return {
          type: 'file.manifest',
          body: {
            sha256: req.sha256,
            ...(first > 0 && { from: first }),
            hashes: encodeBase64Url(hashes),
          },
        };
    });
    links.on('file.request', (from, body) => void this.serve(from, FileRequestBody.parse(body)));
    links.on('file.cancel', (from, body) => this.onCancel(from, FileCancelBody.parse(body)));
    links.onBinary((from, data) => void this.onChunk(from, data));
    links.onLinkDown((userId) => this.onHolderGone(userId));
    links.onLinkUp(() => this.pumpAll());
    this.tick = options.clock.setInterval(() => this.onTick(), 1_000);
  }

  status(sha: string): FileStatus {
    const job = this.jobs.get(sha);
    const row = this.o.store.row(sha);
    if (!row) return { sha256: sha, state: 'missing', received: 0, size: 0 };
    if (row.state === 'complete') {
      // This PC says it has the file: is it still where it was?
      const presence = this.o.store.presence(row);
      if (presence === 'present')
        return { sha256: sha, state: 'complete', received: row.size, size: row.size };
      return {
        sha256: sha,
        state: 'gone',
        received: 0,
        size: row.size,
        ...(presence === 'changed' && { error: 'It was changed after it was shared.' }),
      };
    }
    if (job) {
      const received = Math.min(job.received, row.size);
      const rate = job.state === 'downloading' ? job.meter.rate(this.o.clock.now()) : undefined;
      return {
        sha256: sha,
        state: job.state,
        received,
        size: row.size,
        ...(job.error && { error: job.error }),
        ...(rate !== undefined && {
          bytesPerSecond: Math.round(rate),
          etaSeconds: rate > 0 ? Math.ceil((row.size - received) / rate) : null,
        }),
      };
    }
    const held = row.have ? bitmap.count(row.have, row.chunkCount) : 0;
    return {
      sha256: sha,
      state: 'missing',
      received: Math.min(held * FILE_CHUNK_BYTES, row.size),
      size: row.size,
    };
  }

  /** Start (or resume) a download of a file this PC has noted. */
  download(ref: FileRef): FileStatus {
    const sha = ref.sha256;
    const known = this.o.store.row(sha);
    if (known?.state === 'complete') {
      if (this.o.store.presence(known) === 'present') return this.status(sha);
      // The copy is gone (deleted, or a shared original that changed): fetch it again.
      this.o.store.forget(sha);
    }
    this.o.store.checkPartial(sha);
    let job = this.jobs.get(sha);
    if (!job) {
      const row = this.o.store.row(sha);
      if (!row) throw new Error('unknown file');
      const missing = new Set(this.o.store.missingChunks(sha));
      job = {
        sha,
        size: row.size,
        chunkCount: row.chunkCount,
        missing,
        inflight: new Map(),
        holders: new Map(),
        hashes: undefined,
        live: isUnhashed(row),
        state: 'downloading',
        received: Math.min(row.size, (row.chunkCount - missing.size) * FILE_CHUNK_BYTES),
        meter: new Meter(),
        lastProgress: 0,
        finishing: false,
        lastPump: 0,
      };
      this.jobs.set(sha, job);
      this.byTransferId.set(transferId(sha).toString('hex'), sha);
    }
    job.state = 'downloading';
    delete job.error;
    // Remembered, so a download that is waiting for its sender survives a restart.
    this.o.store.setWanted(sha, true);
    void this.hasRoom(job).then((ok) => {
      if (ok) void this.pump(job);
    });
    return this.status(sha);
  }

  /**
   * Is there room for what is still to come? Files can be any size, so a download that cannot
   * fit says so at once instead of filling the drive and failing at the end.
   */
  private async hasRoom(job: Job): Promise<boolean> {
    try {
      const space = await statfs(this.o.store.saveDir);
      const free = Number(space.bavail) * Number(space.bsize);
      const need = Math.max(0, job.size - job.received);
      if (free >= need + 256 * 1024 * 1024) return true;
      job.state = 'failed';
      job.error = `Not enough free space in ${this.o.store.saveDir}: ${(need / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free.`;
      return false;
    } catch {
      return true; // cannot tell: try
    }
  }

  async cancel(sha: string): Promise<FileStatus> {
    const job = this.jobs.get(sha);
    this.o.store.setWanted(sha, false);
    if (job) {
      this.jobs.delete(sha);
      this.byTransferId.delete(transferId(sha).toString('hex'));
      await this.o.store.abort(sha);
    }
    const status = this.status(sha);
    this.o.progress(status);
    return status;
  }

  /** A peer came online or a link opened: give stalled downloads another go. */
  pumpAll(): void {
    for (const job of this.jobs.values()) void this.pump(job);
  }

  private async pump(job: Job): Promise<void> {
    if (this.stopped || !this.jobs.has(job.sha) || job.finishing) return;
    try {
      await this.pumpInner(job);
    } catch (err) {
      if (!this.stopped)
        this.o.logger.warn('transfer step failed', { sha: job.sha, err: String(err) });
    }
  }

  private async pumpInner(job: Job): Promise<void> {
    job.lastPump = this.o.clock.now();
    if (job.missing.size === 0 && job.inflight.size === 0) {
      await this.finish(job);
      return;
    }
    const { links } = this.o;
    for (const userId of this.o.membersFor(job.sha)) {
      if (!job.holders.has(userId))
        job.holders.set(userId, {
          userId,
          chunks: undefined,
          queried: false,
          strikes: 0,
          inflight: 0,
        });
    }
    // Ask each reachable member what it holds.
    const asks: Promise<void>[] = [];
    for (const holder of job.holders.values()) {
      if (holder.strikes >= MAX_STRIKES) continue;
      if (!links.isReady(holder.userId)) {
        if (this.o.isOnline(holder.userId)) this.o.dial(holder.userId);
        continue;
      }
      if (holder.queried || !links.hasCap(holder.userId, 'files.v1')) continue;
      holder.queried = true;
      asks.push(
        links
          .request(holder.userId, 'file.have', { sha256: job.sha })
          .then((reply) => {
            const have = FileHaveBody.safeParse(reply.body);
            if (!have.success || have.data.sha256 !== job.sha) return;
            if (have.data.have === 'all') holder.chunks = 'all';
            else if (have.data.have === 'partial' && have.data.chunks)
              holder.chunks = decodeBase64Url(have.data.chunks);
            else holder.chunks = undefined;
          })
          .catch(() => {
            holder.queried = false;
          }),
      );
    }
    await Promise.all(asks);

    if (!job.live && !job.hashes) job.hashes = await this.o.store.manifestHashes(job.sha);
    if (!job.live && !job.hashes) {
      for (const holder of job.holders.values()) {
        if (!holder.chunks || !links.isReady(holder.userId)) continue;
        try {
          // The chunk list comes a page at a time (a small file is one page).
          const pages: Buffer[] = [];
          let complete = true;
          for (let first = 0; first < job.chunkCount; first += MANIFEST_PAGE_CHUNKS) {
            const reply = await links.request(holder.userId, 'file.manifest', {
              sha256: job.sha,
              ...(first > 0 && { from: first }),
            });
            const body = FileManifestBody.safeParse(reply.body);
            const page =
              body.success && body.data.hashes ? decodeBase64Url(body.data.hashes) : null;
            const want = Math.min(MANIFEST_PAGE_CHUNKS, job.chunkCount - first) * 32;
            if (!page || page.length !== want) {
              complete = false;
              break;
            }
            pages.push(Buffer.from(page));
          }
          if (!complete) continue;
          const hashes = Buffer.concat(pages);
          if (await this.o.store.setManifest(job.sha, hashes)) {
            job.hashes = hashes;
            break;
          }
          holder.strikes = MAX_STRIKES; // a manifest that does not match the signed hash
        } catch {
          // try the next holder
        }
      }
    }
    if (!job.live && !job.hashes) {
      this.setUnavailable(job);
      return;
    }
    this.assign(job);
  }

  /** Hand out missing chunks to holders with spare capacity. */
  private assign(job: Job): void {
    const { links } = this.o;
    let assigned = false;
    for (const holder of job.holders.values()) {
      if (!holder.chunks || holder.strikes >= MAX_STRIKES || !links.isReady(holder.userId))
        continue;
      if (holder.inflight > REFILL_BELOW) continue;
      const batch: number[] = [];
      for (const index of job.missing) {
        if (job.inflight.size + batch.length >= TOTAL_INFLIGHT) break;
        if (holder.inflight + batch.length >= PER_HOLDER_INFLIGHT) break;
        if (job.inflight.has(index)) continue;
        if (holder.chunks !== 'all' && !bitmap.has(holder.chunks, index)) continue;
        batch.push(index);
      }
      if (batch.length === 0) continue;
      // Ask in whole lots: a trickle of small requests is a frame each, and a fast link makes
      // hundreds of them. Something still in flight brings the next chance; at the very end, and
      // when nothing is in flight, ask for whatever is left.
      const last = batch.length >= job.missing.size - job.inflight.size;
      if (batch.length < MAX_CHUNKS_PER_REQUEST && holder.inflight > 0 && !last) continue;
      const now = this.o.clock.now();
      for (let i = 0; i < batch.length; i += MAX_CHUNKS_PER_REQUEST) {
        const part = batch.slice(i, i + MAX_CHUNKS_PER_REQUEST);
        if (
          !links.send(holder.userId, 'file.request', {
            sha256: job.sha,
            chunks: part,
            have: Math.min(job.received, job.size),
          })
        )
          break;
        for (const index of part) job.inflight.set(index, { holder: holder.userId, at: now });
        holder.inflight += part.length;
        assigned = true;
      }
    }
    if (job.state !== 'downloading' && assigned) {
      job.state = 'downloading';
      this.o.progress(this.status(job.sha));
    }
    if (!assigned && job.inflight.size === 0) this.setUnavailable(job);
  }

  private setUnavailable(job: Job): void {
    if (job.state === 'unavailable') return;
    job.state = 'unavailable';
    // Ask again next time someone comes online.
    for (const holder of job.holders.values()) holder.queried = false;
    this.o.progress(this.status(job.sha));
  }

  private async onChunk(from: string, data: Uint8Array): Promise<void> {
    if (this.stopped || data.length < BINARY_FRAME_HEADER_BYTES) return;
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const sha = this.byTransferId.get(buf.subarray(0, 16).toString('hex'));
    const job = sha ? this.jobs.get(sha) : undefined;
    if (!job || (!job.live && !job.hashes)) return;
    const offset = Number(buf.readBigUInt64BE(16));
    const index = offset / FILE_CHUNK_BYTES;
    const pending = job.inflight.get(index);
    // Only chunks we asked this peer for are accepted.
    if (!Number.isInteger(index) || !pending || pending.holder !== from) return;
    job.inflight.delete(index);
    const holder = job.holders.get(from);
    if (holder) holder.inflight = Math.max(0, holder.inflight - 1);
    let ok: boolean;
    try {
      ok = await this.o.store.writeChunk(
        job.sha,
        index,
        buf.subarray(BINARY_FRAME_HEADER_BYTES),
        job.hashes,
      );
    } catch (err) {
      if (this.stopped) return;
      throw err;
    }
    if (this.stopped) return;
    if (ok) {
      job.missing.delete(index);
      job.received += buf.length - BINARY_FRAME_HEADER_BYTES;
      const now = this.o.clock.now();
      job.meter.add(now, buf.length - BINARY_FRAME_HEADER_BYTES);
      if (now - job.lastProgress >= PROGRESS_EVERY_MS) {
        job.lastProgress = now;
        this.o.progress(this.status(job.sha));
      }
    } else {
      this.o.logger.warn('corrupt file chunk', { from, sha: job.sha, index });
      if (holder) holder.strikes++;
    }
    void this.pump(job);
  }

  private onCancel(from: string, body: { sha256: string; chunks?: number[] | undefined }): void {
    const job = this.jobs.get(body.sha256);
    const holder = job?.holders.get(from);
    if (!job || !holder) return;
    for (const index of body.chunks ?? [...job.inflight.keys()]) {
      if (job.inflight.get(index)?.holder !== from) continue;
      job.inflight.delete(index);
      holder.inflight = Math.max(0, holder.inflight - 1);
      if (holder.chunks && holder.chunks !== 'all')
        holder.chunks[index >> 3]! &= ~(1 << (index & 7));
      else if (holder.chunks === 'all') holder.chunks = undefined;
    }
    void this.pump(job);
  }

  private onHolderGone(userId: string): void {
    for (const job of this.jobs.values()) {
      const holder = job.holders.get(userId);
      if (!holder) continue;
      for (const [index, pending] of job.inflight)
        if (pending.holder === userId) job.inflight.delete(index);
      holder.inflight = 0;
      holder.queried = false;
      void this.pump(job);
    }
  }

  private onTick(): void {
    const now = this.o.clock.now();
    for (const [sha, byUser] of this.uploads) {
      let changed = false;
      for (const [userId, up] of byUser) {
        if (now - up.lastAt < UPLOAD_IDLE_MS) continue;
        byUser.delete(userId);
        changed = true;
      }
      if (byUser.size === 0) this.uploads.delete(sha);
      if (changed) this.emitUploads(sha, true);
    }
    for (const job of this.jobs.values()) {
      let requeued = false;
      for (const [index, pending] of job.inflight) {
        if (now - pending.at < CHUNK_TIMEOUT_MS) continue;
        job.inflight.delete(index);
        const holder = job.holders.get(pending.holder);
        if (holder) holder.inflight = Math.max(0, holder.inflight - 1);
        requeued = true;
      }
      const stalled = job.state === 'unavailable' && now - job.lastPump >= UNAVAILABLE_RETRY_MS;
      if (requeued || stalled || (job.state === 'downloading' && job.inflight.size === 0))
        void this.pump(job);
    }
  }

  private async finish(job: Job): Promise<void> {
    if (job.finishing) return;
    job.finishing = true;
    const ok = await this.o.store.finish(job.sha, this.o.clock.now());
    this.jobs.delete(job.sha);
    this.byTransferId.delete(transferId(job.sha).toString('hex'));
    if (!ok) {
      this.o.logger.warn('downloaded file failed its hash check', { sha: job.sha });
      this.o.progress({
        ...this.status(job.sha),
        state: 'failed',
        error: 'The file did not match its fingerprint.',
      });
      return;
    }
    this.o.progress(this.status(job.sha));
    this.o.completed(job.sha);
  }

  /** Answer a chunk request with binary frames, and a cancel for anything not held. */
  private async serve(
    from: string,
    req: { sha256: string; chunks: number[]; have?: number | undefined },
  ): Promise<void> {
    if (this.stopped) return;
    if (!this.o.mayServe(req.sha256, from)) {
      this.o.links.send(from, 'file.cancel', { sha256: req.sha256, chunks: req.chunks });
      return;
    }
    const active = this.serving.get(from) ?? 0;
    if (active >= LINK_LIMITS.openFileTransfers) {
      this.o.links.send(from, 'file.cancel', { sha256: req.sha256, chunks: req.chunks });
      return;
    }
    this.serving.set(from, active + 1);
    const missing: number[] = [];
    try {
      const id = transferId(req.sha256);
      // Reads run a few chunks ahead of the sending, so the disk and the network overlap.
      const reads = new Map<number, Promise<Buffer | undefined>>();
      const read = (k: number) => {
        const index = req.chunks[k];
        if (index !== undefined && !reads.has(k))
          reads.set(
            k,
            this.o.store.readChunk(req.sha256, index).catch(() => undefined),
          );
      };
      for (let k = 0; k < READ_AHEAD; k++) read(k);
      for (const [k, index] of req.chunks.entries()) {
        if (this.stopped) return;
        read(k + READ_AHEAD);
        const data = await reads.get(k);
        reads.delete(k);
        if (!data) {
          missing.push(index);
          continue;
        }
        const header = Buffer.alloc(BINARY_FRAME_HEADER_BYTES);
        id.copy(header, 0);
        header.writeBigUInt64BE(BigInt(index * FILE_CHUNK_BYTES), 16);
        if (!this.o.links.sendBinary(from, Buffer.concat([header, data]))) return;
        this.noteUpload(from, req.sha256, data.length, req.have);
      }
      if (missing.length > 0)
        this.o.links.send(from, 'file.cancel', { sha256: req.sha256, chunks: missing });
    } finally {
      this.serving.set(from, (this.serving.get(from) ?? 1) - 1);
    }
  }

  /** Count bytes sent to a peer, to show "Sending to Asha: 40%, 80 MB/s, 1 min left". */
  private noteUpload(to: string, sha: string, bytes: number, have: number | undefined): void {
    const row = this.o.store.row(sha);
    if (!row) return;
    const now = this.o.clock.now();
    let byUser = this.uploads.get(sha);
    if (!byUser) this.uploads.set(sha, (byUser = new Map()));
    let up = byUser.get(to);
    if (!up || now - up.lastAt > UPLOAD_IDLE_MS) {
      up = {
        userId: to,
        size: row.size,
        base: Math.min(row.size, have ?? 0),
        sent: 0,
        lastAt: now,
        meter: new Meter(),
      };
      byUser.set(to, up);
    }
    up.sent += bytes;
    up.lastAt = now;
    up.meter.add(now, bytes);
    // Always report the moment the last byte goes out, so the card reaches 100%.
    this.emitUploads(sha, up.base + up.sent >= up.size);
  }

  private emitUploads(sha: string, force: boolean): void {
    const now = this.o.clock.now();
    if (!force && now - (this.lastUploadEmit.get(sha) ?? 0) < PROGRESS_EVERY_MS) return;
    this.lastUploadEmit.set(sha, now);
    const uploads = this.uploadsOf(sha);
    if (uploads.length === 0) this.lastUploadEmit.delete(sha);
    this.o.uploads(sha, uploads);
  }

  /** Who is being sent this file now, and how far along each is. */
  uploadsOf(sha: string): FileUpload[] {
    const now = this.o.clock.now();
    return [...(this.uploads.get(sha)?.values() ?? [])].map((up) => {
      const total = Math.max(1, up.size - up.base);
      const sent = Math.min(up.sent, total);
      const rate = up.meter.rate(now);
      return {
        userId: up.userId,
        sent,
        total,
        bytesPerSecond: Math.round(rate ?? 0),
        etaSeconds: rate !== undefined && rate > 0 ? Math.ceil((total - sent) / rate) : null,
      };
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.tick) this.o.clock.clearInterval(this.tick);
    for (const sha of [...this.jobs.keys()]) void this.o.store.abort(sha);
    this.jobs.clear();
  }
}

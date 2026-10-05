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
} from '@officemesh/protocol';
import type { FileStatus } from '@officemesh/protocol/ipc';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';
import type { LinkManager } from '../link/link-manager.ts';
import { bitmap, type FileStore } from './store.ts';

/**
 * Up to 32 chunks in flight per holder, refilled once half have arrived, in requests of
 * 16 chunks (16 MB). That keeps requests near 13 per second even at 200 MB/s, well inside
 * the link's 50-text-frames-per-second abuse limit (a request per chunk tripped it).
 */
const PER_HOLDER_INFLIGHT = 32;
const REFILL_BELOW = PER_HOLDER_INFLIGHT / 2;
const TOTAL_INFLIGHT = 64;
const CHUNK_TIMEOUT_MS = 20_000;
const MAX_STRIKES = 3;
const PROGRESS_EVERY_MS = 250;
/** Re-ask holders of a stalled download this often (dialing still follows link backoff). */
const UNAVAILABLE_RETRY_MS = 5_000;

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
  state: 'downloading' | 'unavailable' | 'failed';
  error?: string;
  received: number;
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
  completed(sha: string): void;
}

/** Transfer IDs are the first 16 bytes of the file's SHA-256. */
function transferId(sha: string): Buffer {
  return Buffer.from(sha.slice(0, 32), 'hex');
}

/**
 * Chunked peer-to-peer file transfer. Downloads pull 1 MB chunks from every member who
 * holds them, verify each against the signed manifest, resume after interruptions, and
 * answer other members' requests for anything this PC holds.
 */
export class TransferManager {
  private readonly o: TransferOptions;
  private readonly jobs = new Map<string, Job>();
  private readonly byTransferId = new Map<string, string>();
  private readonly serving = new Map<string, number>();
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
      if (held)
        return {
          type: 'file.have',
          body: { sha256: req.sha256, have: 'partial', chunks: encodeBase64Url(held) },
        };
      return { type: 'file.have', body: { sha256: req.sha256, have: 'none' } };
    });
    links.on('file.manifest', async (from, body) => {
      const req = FileManifestBody.parse(body);
      if (req.hashes || !this.o.mayServe(req.sha256, from)) return;
      const hashes = await this.o.store.manifestHashes(req.sha256);
      if (hashes)
        return {
          type: 'file.manifest',
          body: { sha256: req.sha256, hashes: encodeBase64Url(hashes) },
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
    if (this.o.store.isComplete(sha))
      return { sha256: sha, state: 'complete', received: row.size, size: row.size };
    if (job) {
      return {
        sha256: sha,
        state: job.state,
        received: Math.min(job.received, row.size),
        size: row.size,
        ...(job.error && { error: job.error }),
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
    if (this.o.store.isComplete(sha)) return this.status(sha);
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
        state: 'downloading',
        received: (row.chunkCount - missing.size) * FILE_CHUNK_BYTES,
        lastProgress: 0,
        finishing: false,
        lastPump: 0,
      };
      this.jobs.set(sha, job);
      this.byTransferId.set(transferId(sha).toString('hex'), sha);
    }
    job.state = 'downloading';
    delete job.error;
    void this.pump(job);
    return this.status(sha);
  }

  async cancel(sha: string): Promise<FileStatus> {
    const job = this.jobs.get(sha);
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

    if (!job.hashes) job.hashes = await this.o.store.manifestHashes(job.sha);
    if (!job.hashes) {
      for (const holder of job.holders.values()) {
        if (!holder.chunks || !links.isReady(holder.userId)) continue;
        try {
          const reply = await links.request(holder.userId, 'file.manifest', { sha256: job.sha });
          const body = FileManifestBody.safeParse(reply.body);
          if (body.success && body.data.hashes) {
            const hashes = Buffer.from(decodeBase64Url(body.data.hashes));
            if (await this.o.store.setManifest(job.sha, hashes)) {
              job.hashes = hashes;
              break;
            }
            holder.strikes = MAX_STRIKES; // a manifest that does not match the signed hash
          }
        } catch {
          // try the next holder
        }
      }
    }
    if (!job.hashes) {
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
      const now = this.o.clock.now();
      for (let i = 0; i < batch.length; i += MAX_CHUNKS_PER_REQUEST) {
        const part = batch.slice(i, i + MAX_CHUNKS_PER_REQUEST);
        if (!links.send(holder.userId, 'file.request', { sha256: job.sha, chunks: part })) break;
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
    if (!job || !job.hashes) return;
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
  private async serve(from: string, req: { sha256: string; chunks: number[] }): Promise<void> {
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
      for (const index of req.chunks) {
        if (this.stopped) return;
        const data = await this.o.store.readChunk(req.sha256, index).catch(() => undefined);
        if (!data) {
          missing.push(index);
          continue;
        }
        const header = Buffer.alloc(BINARY_FRAME_HEADER_BYTES);
        id.copy(header, 0);
        header.writeBigUInt64BE(BigInt(index * FILE_CHUNK_BYTES), 16);
        if (!this.o.links.sendBinary(from, Buffer.concat([header, data]))) return;
      }
      if (missing.length > 0)
        this.o.links.send(from, 'file.cancel', { sha256: req.sha256, chunks: missing });
    } finally {
      this.serving.set(from, (this.serving.get(from) ?? 1) - 1);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.tick) this.o.clock.clearInterval(this.tick);
    for (const sha of [...this.jobs.keys()]) void this.o.store.abort(sha);
    this.jobs.clear();
  }
}

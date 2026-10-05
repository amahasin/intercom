import type { PeerChannel } from '../interfaces.ts';

type Data = string | Uint8Array;

/**
 * Shared PeerChannel plumbing: buffers frames that arrive before anyone listens (the
 * remote `hello` can beat our own listener registration) and fires close exactly once.
 */
export abstract class BaseChannel implements PeerChannel {
  readonly remoteUserId: string;
  readonly remoteSpki: Buffer;
  private readonly messageListeners = new Set<(data: Data) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private backlog: Data[] | undefined = [];
  private closedReason: string | undefined;

  constructor(remoteUserId: string, remoteSpki: Buffer) {
    this.remoteUserId = remoteUserId;
    this.remoteSpki = remoteSpki;
  }

  abstract send(data: Data): void;
  abstract close(reason?: string): void;

  onMessage(listener: (data: Data) => void): () => void {
    this.messageListeners.add(listener);
    if (this.backlog) {
      const pending = this.backlog;
      this.backlog = undefined;
      for (const d of pending) listener(d);
    }
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason !== undefined) {
      queueMicrotask(() => listener(this.closedReason!));
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  get isClosed(): boolean {
    return this.closedReason !== undefined;
  }

  protected deliver(data: Data): void {
    if (this.closedReason !== undefined) return;
    if (this.backlog) this.backlog.push(data);
    else for (const l of this.messageListeners) l(data);
  }

  protected closed(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.messageListeners.clear();
    for (const l of this.closeListeners) l(reason);
    this.closeListeners.clear();
  }
}

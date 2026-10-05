/**
 * Every time-based and network behaviour in the core sits behind these interfaces so
 * tests can substitute fakes (plan section 4, rule 5).
 */

export type TimerHandle = { readonly __timer: unique symbol };

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export interface DatagramSource {
  address: string;
  port: number;
}

/** Sends and receives discovery beacons. Real driver: UDP multicast (M1). Tests: loopback hub. */
export interface DiscoveryDriver {
  /** Send one datagram to every reachable peer (multicast plus broadcast fallback). */
  send(datagram: Uint8Array): void;
  onDatagram(listener: (datagram: Uint8Array, from: DatagramSource) => void): () => void;
  close(): Promise<void>;
}

/** A framed, authenticated, bidirectional channel to one peer. */
export interface PeerChannel {
  /** The userId proven by the peer's TLS certificate. */
  readonly remoteUserId: string;
  send(data: string | Uint8Array): void;
  onMessage(listener: (data: string | Uint8Array) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(reason?: string): void;
}

export interface DialTarget {
  address: string;
  port: number;
  expectedUserId: string;
}

/** Opens peer links. Real dialer: WebSocket over mutual TLS (M1). Tests: in-memory, with faults. */
export interface Dialer {
  dial(target: DialTarget): Promise<PeerChannel>;
}

/**
 * Seals the identity private key at rest. In the app this is Electron safeStorage
 * (Windows DPAPI, bound to the Windows account), reached through the main process.
 */
export interface KeyProtector {
  readonly scheme: 'safeStorage' | 'insecure-test';
  protect(plain: Uint8Array): Promise<Uint8Array>;
  unprotect(sealed: Uint8Array): Promise<Uint8Array>;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

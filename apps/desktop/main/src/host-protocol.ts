/**
 * Control messages between the Electron main process and the core's utility process.
 * This is app-internal glue (the renderer never sees it); renderer traffic uses the
 * typed IPC API on a separate MessagePort.
 */

export interface InitMessage {
  kind: 'init';
  dataDir: string;
  profile: string;
  appVersion: string;
}

/** Carries a fresh MessagePort for one renderer (sent with the port as a transfer). */
export interface AttachMessage {
  kind: 'attach';
  windowId: number;
}

export interface KeyProtectResponse {
  kind: 'key-protect-res';
  id: number;
  ok: boolean;
  /** base64 */
  data?: string;
  error?: string;
}

export interface ShutdownMessage {
  kind: 'shutdown';
}

export type MainToCore = InitMessage | AttachMessage | KeyProtectResponse | ShutdownMessage;

/** The core asks main to seal/unseal bytes with safeStorage, which only exists in main. */
export interface KeyProtectRequest {
  kind: 'key-protect-req';
  id: number;
  op: 'protect' | 'unprotect';
  /** base64 */
  data: string;
}

export interface CoreStatusMessage {
  kind: 'status';
  state: 'ready' | 'error' | 'stopped';
  message?: string;
}

export type CoreToMain = KeyProtectRequest | CoreStatusMessage;

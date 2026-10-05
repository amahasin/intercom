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
  network: {
    discoveryPort?: number;
    linkPort?: number;
    loopbackOnly: boolean;
  };
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

/** Idle (5 minutes without input) and screen-lock state, from powerMonitor. */
export interface SystemStateMessage {
  kind: 'system';
  idle?: boolean;
  locked?: boolean;
}

export interface PowerMessage {
  kind: 'power';
  event: 'suspend' | 'resume';
}

/** What main found out about Windows Firewall and the network category. */
export interface HostNetworkMessage {
  kind: 'host-network';
  firewall: 'checking' | 'ok' | 'missing' | 'unknown';
  publicNetwork: boolean;
}

export interface HostResponse {
  kind: 'host-res';
  id: number;
  ok: boolean;
  error?: string;
}

export interface ShutdownMessage {
  kind: 'shutdown';
}

export type MainToCore =
  | InitMessage
  | AttachMessage
  | KeyProtectResponse
  | SystemStateMessage
  | PowerMessage
  | HostNetworkMessage
  | HostResponse
  | ShutdownMessage;

/** The core asks main to seal/unseal bytes with safeStorage, which only exists in main. */
export interface KeyProtectRequest {
  kind: 'key-protect-req';
  id: number;
  op: 'protect' | 'unprotect';
  /** base64 */
  data: string;
}

/** The core asks main for something only the host can do. */
export interface HostRequest {
  kind: 'host-req';
  id: number;
  op: 'fix-firewall' | 'open-network-settings';
}

export interface CoreStatusMessage {
  kind: 'status';
  state: 'ready' | 'error' | 'stopped';
  message?: string;
}

export type CoreToMain = KeyProtectRequest | HostRequest | CoreStatusMessage;

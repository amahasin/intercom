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
  /** The office's shared folder of installers (installed builds only). */
  updateFolder?: string;
  /** The GitHub repository (owner/name) whose releases are looked at for updates (installed builds only). */
  updateRepo?: string;
  /** The project's GitHub repository (owner/name), for the About page (every build). */
  repository?: string;
  /**
   * The last start ended with Windows refusing to run an installer (this is the app started again
   * after that): which version, and whether Smart App Control is on.
   */
  installerBlocked?: { version: string; smartAppControl: boolean };
  network: {
    discoveryPort?: number;
    linkPort?: number;
    loopbackOnly: boolean;
  };
  /** Where Windows keeps this user's Downloads folder (received files go to a folder in it). */
  downloadsDir?: string;
  /** Tests: remote help with a stand-in for the sharing helper. */
  fakeRemoteAssist?: boolean;
  /** The remote help helper program (intercom-assist.exe), if this install has it. */
  assistHelper?: string;
  /** Host relay (M6): the media worker (absent on builds without one) and test hooks. */
  relay: {
    workerBin?: string;
    score?: number;
    meshLimit?: number;
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

/**
 * Idle (5 minutes without input) and screen-lock state, from powerMonitor, and whether one of the
 * app's windows is in front (visible, not minimised, with the focus).
 */
export interface SystemStateMessage {
  kind: 'system';
  idle?: boolean;
  locked?: boolean;
  foreground?: boolean;
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
  /** The result, for requests that return one (screen sources). */
  data?: unknown;
}

export interface ShutdownMessage {
  kind: 'shutdown';
}

/** The user typed a reply into a toast, or clicked it. */
export interface ToastActionMessage {
  kind: 'toast-action';
  convId: string;
  target?: { author: string; seq: number };
  reply?: string;
}

/** The page asks for a picture or video by its fingerprint: where does the file live? */
export interface FilePathRequest {
  kind: 'file-path-req';
  id: number;
  sha: string;
  type: string;
}

/** The user closed a call's window: leave that call (nothing happens if it already ended). */
export interface CallWindowClosedMessage {
  kind: 'call-window-closed';
  callId: string;
}

export type MainToCore =
  | InitMessage
  | CallWindowClosedMessage
  | FilePathRequest
  | AttachMessage
  | KeyProtectResponse
  | SystemStateMessage
  | PowerMessage
  | HostNetworkMessage
  | HostResponse
  | ToastActionMessage
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
  op:
    | 'fix-firewall'
    | 'open-network-settings'
    | 'screen-sources'
    | 'verify-signature'
    | 'pick-profile'
    | 'pick-folder'
    | 'pick-share-folder';
  /** verify-signature: the file to check (null: this app). */
  path?: string | null;
}

export interface CoreStatusMessage {
  kind: 'status';
  state: 'ready' | 'error' | 'stopped';
  message?: string;
}

/** Fire-and-forget requests from the core for things only main can do. */
export type HostEvent =
  | {
      /** The calls this PC has now: main opens a window for each and closes the others. */
      kind: 'calls';
      calls: Array<{ callId: string; ringing: boolean; media: 'audio' | 'video'; name: string }>;
    }
  | {
      kind: 'notify';
      toast: {
        id: string;
        convId: string;
        target: { author: string; seq: number };
        title: string;
        body: string;
        urgent: boolean;
        call?: boolean;
        noReply?: boolean;
      };
    }
  | { kind: 'screen-border'; sourceId: string | null }
  | { kind: 'badge'; count: number }
  | { kind: 'open-path'; path: string }
  | { kind: 'show-in-folder'; path: string }
  | { kind: 'snip' }
  | { kind: 'start-with-windows'; enabled: boolean }
  | { kind: 'theme'; theme: 'system' | 'light' | 'dark' }
  | { kind: 'run-installer'; path: string }
  | { kind: 'relaunch' };

export interface FilePathResponse {
  kind: 'file-path-res';
  id: number;
  path: string | null;
}

export type CoreToMain =
  KeyProtectRequest | HostRequest | CoreStatusMessage | FilePathResponse | HostEvent;

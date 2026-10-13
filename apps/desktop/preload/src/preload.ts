/**
 * Sandboxed preload. Exposes exactly one thing to the page: a frame bridge to the core's
 * MessagePort. The typed API on top of it lives in @officemesh/protocol/ipc.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

type Listener = (frame: unknown) => void;

let port: MessagePort | undefined;
const queued: unknown[] = [];
const listeners = new Set<Listener>();

ipcRenderer.on('officemesh:core-port', (event) => {
  const next = event.ports[0];
  if (!next) return;
  port?.close();
  port = next;
  port.onmessage = (e: MessageEvent) => {
    for (const listener of listeners) listener(e.data);
  };
  for (const frame of queued.splice(0)) port.postMessage(frame);
});

function isRequestFrame(frame: unknown): boolean {
  return (
    typeof frame === 'object' && frame !== null && (frame as { kind?: unknown }).kind === 'req'
  );
}

contextBridge.exposeInMainWorld('officemesh', {
  send(frame: unknown): void {
    if (!isRequestFrame(frame)) return;
    if (port) port.postMessage(frame);
    else queued.push(frame);
  },
  /**
   * The path of a file the user dropped or picked, so the core can read it directly.
   * A DOM helper, not a channel: it only works on File objects from the user.
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onFrame(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
});

/**
 * Window controls for the call windows (see main/src/windows.ts). Main accepts each message
 * only from the kind of window it is meant for, so these grant nothing to the main window.
 */
contextBridge.exposeInMainWorld('officemeshWindow', {
  /** Close this window (a call window after "Call ended", the small incoming-call window). */
  close(): void {
    ipcRenderer.send('window:close');
  },
  /** The incoming-call window asks to be this tall (its content changes with the options). */
  fit(height: number): void {
    ipcRenderer.send('window:fit', Math.round(height));
  },
  showMain(): void {
    ipcRenderer.send('window:show-main');
  },
  /** Flash and raise this call window: something needs the user's answer. */
  attention(): void {
    ipcRenderer.send('window:attention');
  },
  /**
   * Remote control of the screen being shared: tell main whether control is granted, and pass
   * on the controller's mouse and keyboard events. Main re-checks everything (see
   * main/src/remote-input.ts); the page cannot make main do more than that.
   */
  remoteControl(active: boolean): Promise<{ ok: boolean; reason?: string }> {
    return ipcRenderer.invoke('rc:state', active) as Promise<{ ok: boolean; reason?: string }>;
  },
  /** Where the shared pointer is (fractions of the shared surface) while control is on. */
  onRemoteCursor(
    listener: (cursor: { x: number; y: number; by: 'controller' | 'sharer' }) => void,
  ) {
    const handler = (_e: unknown, cursor: { x: number; y: number; by: 'controller' | 'sharer' }) =>
      listener(cursor);
    ipcRenderer.on('rc:cursor', handler);
    return () => ipcRenderer.off('rc:cursor', handler);
  },
  /** Input stopped working (the helper died, the shared window closed): control must end. */
  onRemoteFailed(listener: (reason: string) => void) {
    const handler = (_e: unknown, reason: string) => listener(reason);
    ipcRenderer.on('rc:failed', handler);
    return () => ipcRenderer.off('rc:failed', handler);
  },
  remoteInput(event: unknown): void {
    ipcRenderer.send('rc:input', event);
  },
  focusCall(callId: string): void {
    ipcRenderer.send('window:focus-call', callId);
  },
});

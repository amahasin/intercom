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

import type { IpcFrame } from '@officemesh/protocol/ipc';

declare global {
  interface Window {
    /** Exposed by the preload: a frame bridge to the core, nothing else. */
    officemesh: {
      send(frame: IpcFrame): void;
      onFrame(listener: (frame: unknown) => void): () => void;
    };
  }
}

export {};

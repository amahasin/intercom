import type { IpcFrame } from '@officemesh/protocol/ipc';

declare global {
  interface Window {
    /** Exposed by the preload: a frame bridge to the core, nothing else. */
    officemesh: {
      send(frame: IpcFrame): void;
      /** Local path of a file the user dropped or picked ('' for pasted data). */
      pathForFile(file: File): string;
      onFrame(listener: (frame: unknown) => void): () => void;
    };
  }
}

export {};

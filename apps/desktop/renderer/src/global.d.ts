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
    /** Window controls, exposed by the preload to the call windows only (see main/windows.ts). */
    officemeshWindow?: {
      close(): void;
      fit(height: number): void;
      showMain(): void;
      focusCall(callId: string): void;
      attention(): void;
      remoteControl(active: boolean): Promise<{ ok: boolean; reason?: string }>;
      onRemoteCursor(
        listener: (cursor: { x: number; y: number; by: 'controller' | 'sharer' }) => void,
      ): () => void;
      onRemoteFailed(listener: (reason: string) => void): () => void;
      remoteInput(event: unknown): void;
    };
  }
}

export {};

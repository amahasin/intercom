import { create } from 'zustand';
import { ROLE } from '../role.ts';
import { core } from '../state.ts';
import { previewKind, type PreviewFile } from './kinds.ts';

interface PreviewState {
  /** The file open in the built-in viewer, if any. */
  file: PreviewFile | undefined;
}

export const usePreview = create<PreviewState>(() => ({ file: undefined }));

/**
 * Open a file: in the built-in viewer when it is a kind the viewer shows (main window only),
 * otherwise in whatever the PC uses for it.
 */
export function openFile(file: PreviewFile): void {
  if (ROLE === 'main' && previewKind(file)) usePreview.setState({ file });
  else void core.invoke('files.open', { sha256: file.sha256 });
}

export const closePreview = (): void => usePreview.setState({ file: undefined });

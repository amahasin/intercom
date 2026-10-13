import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';

/** While a drag is going on the browser reports it about every 50 to 350 ms; silence this long means it ended. */
const SILENCE_MS = 800;

/**
 * Dropping files onto a pane: `dragging` says whether the "Drop files" cover should show, and
 * `bind` goes on the pane. The cover must never be left behind. A drag that is cancelled
 * (Escape), leaves the window, or ends somewhere else does not always fire an event here, so
 * the cover also goes away when the drag stops being reported, and on any drag end, drop,
 * key press or loss of focus in the window.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const stop = useCallback(() => {
    window.clearTimeout(timer.current);
    setDragging(false);
  }, []);

  useEffect(() => {
    const end = () => stop();
    const keys = (e: KeyboardEvent) => e.key === 'Escape' && end();
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', keys);
    // A drag leaving the window altogether.
    const leave = (e: globalThis.DragEvent) => {
      if (e.relatedTarget === null) end();
    };
    document.addEventListener('dragleave', leave);
    return () => {
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', keys);
      document.removeEventListener('dragleave', leave);
      window.clearTimeout(timer.current);
    };
  }, [stop]);

  const bind = {
    onDragOver: (e: DragEvent) => {
      if (!enabled || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragging(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDragging(false), SILENCE_MS);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) stop();
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      stop();
      if (enabled) onFiles([...e.dataTransfer.files]);
    },
  };
  return { dragging, bind };
}

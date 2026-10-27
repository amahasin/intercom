import { useEffect } from 'react';
import { useAttachments } from '../chat/attachments.ts';
import { useDrafts } from '../chat/drafts.ts';
import { core, useApp } from '../state.ts';

/** How often it is said again that something is unsent (the core forgets it after 90 seconds). */
const REPEAT_MS = 30_000;

/**
 * Tells the core whether the window holds something typed or queued that has not been sent: text in
 * a composer, files waiting to go with a message, a message being edited, a poll being made. The
 * core uses it to choose when to restart for an update (never then), since nothing here is kept
 * if the app restarts. Draws nothing.
 */
export function UnsentReporter() {
  const drafts = useDrafts((s) => s.count);
  const queued = useAttachments(
    (s) =>
      Object.values(s.byKey).some((list) => list.length > 0) || Object.keys(s.preparing).length > 0,
  );
  const editing = useApp((s) => !!s.editing);
  const unsent = drafts > 0 || queued || editing;
  useEffect(() => {
    const tell = () => void core.invoke('app.activity', { unsent }).catch(() => {});
    tell();
    if (!unsent) return;
    const timer = window.setInterval(tell, REPEAT_MS);
    return () => window.clearInterval(timer);
  }, [unsent]);
  return null;
}

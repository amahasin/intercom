/**
 * Press Escape twice in a chat and the chat closes, leaving your own welcome page. Escape that is
 * already doing something (closing a menu, a dialog, a picture, a hover card) is not counted, so
 * a double press after that never throws the person out of their conversation.
 */
import { usePreview } from '../preview/store.ts';
import { selectConversation, useApp } from '../state.ts';

/** The second press must come this soon after the first. */
export const DOUBLE_ESCAPE_MS = 500;

/** Something on top of the page that Escape would close first. */
const OVERLAYS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"]';

/**
 * Something is open on top of the page. The composer keeps an empty "Typeahead menu" listbox in the
 * page all the time, so a menu counts when it is shown and has something in it.
 */
function overlayOpen(): boolean {
  for (const el of document.querySelectorAll(OVERLAYS))
    if (el.childElementCount > 0 && el.getClientRects().length > 0) return true;
  return false;
}

export function initDoubleEscape(): () => void {
  let last = 0;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.repeat) return;
    const s = useApp.getState();
    const inChat = s.rail === 'chat' && s.selectedConv !== undefined;
    // Escape that closes something is that press's whole job.
    const covered = e.defaultPrevented || overlayOpen() || usePreview.getState().file !== undefined;
    if (!inChat || covered) {
      last = 0;
      return;
    }
    const now = Date.now();
    if (now - last <= DOUBLE_ESCAPE_MS) {
      last = 0;
      void selectConversation(undefined);
    } else {
      last = now;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

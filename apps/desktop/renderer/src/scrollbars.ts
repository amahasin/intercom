/**
 * Scroll bars that hide themselves. A box that scrolls gets `.om-scrolling` while it moves and
 * for a moment after; base.css only draws the thumb then. So the bar can still be grabbed, it
 * also shows while the pointer is on the bar's strip. One listener for the whole page: scroll
 * events do not bubble, but they can be caught on the way down.
 */
const SHOWN = 'om-scrolling';
/** How long a bar stays after the last movement. */
const LINGER_MS = 1_000;
/** The strip at a box's edge that counts as "on the bar" (the bar is 12 px wide). */
const STRIP = 14;

const timers = new WeakMap<Element, number>();

function show(el: Element): void {
  el.classList.add(SHOWN);
  window.clearTimeout(timers.get(el));
  timers.set(
    el,
    window.setTimeout(() => el.classList.remove(SHOWN), LINGER_MS),
  );
}

/** The box under the pointer (or one around it) whose scroll bar the pointer is on. */
function barUnder(e: PointerEvent): Element | undefined {
  for (let el = e.target instanceof Element ? e.target : null; el; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const vertical = el.scrollHeight > el.clientHeight && el.offsetWidth - el.clientWidth >= 8;
    const horizontal = el.scrollWidth > el.clientWidth && el.offsetHeight - el.clientHeight >= 8;
    if (!vertical && !horizontal) continue;
    const r = el.getBoundingClientRect();
    if (vertical && e.clientX >= r.right - STRIP && e.clientX <= r.right) return el;
    if (horizontal && e.clientY >= r.bottom - STRIP && e.clientY <= r.bottom) return el;
  }
  return undefined;
}

export function initScrollbars(): void {
  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target === document ? document.scrollingElement : e.target;
      if (el instanceof Element) show(el);
    },
    { capture: true, passive: true },
  );
  // Looked at once a frame at most, however fast the pointer moves.
  let last: PointerEvent | undefined;
  let queued = false;
  document.addEventListener(
    'pointermove',
    (e) => {
      last = e;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const el = last && barUnder(last);
        if (el) show(el);
      });
    },
    { passive: true },
  );
}

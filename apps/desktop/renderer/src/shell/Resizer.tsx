import { useCallback, useEffect, useRef, useState } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  handle: {
    position: 'relative',
    flex: 'none',
    width: '8px',
    marginLeft: '-4px',
    marginRight: '-4px',
    zIndex: 5,
    cursor: 'col-resize',
    touchAction: 'none',
    outline: 'none',
    // A thin line shows where the edge is while pointing at it or dragging.
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: '3px',
      width: '2px',
      background: 'transparent',
      transitionProperty: 'background',
      transitionDuration: tokens.durationFast,
    },
    ':hover::after': { background: tokens.colorBrandStroke1 },
    ':focus-visible::after': { background: tokens.colorBrandStroke1 },
  },
  dragging: { '::after': { background: tokens.colorBrandStroke1 } },
});

function load(key: string, fallback: number, min: number, max: number): number {
  try {
    const n = Number(window.localStorage.getItem(`intercom.pane.${key}`));
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The width of a side pane the user can drag wider or narrower. Remembered per `key` on this
 * PC. `edge` is the side of the pane the drag handle is on: a pane on the left of the page has
 * its handle on its right edge (dragging right widens it), a pane on the right the opposite.
 */
export function useResizableWidth(
  key: string,
  initial: number,
  min: number,
  max: number,
  edge: 'right' | 'left',
) {
  const [width, setWidth] = useState(() => load(key, initial, min, max));
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });
  const clamp = useCallback((w: number) => Math.min(max, Math.max(min, Math.round(w))), [min, max]);

  useEffect(() => {
    try {
      window.localStorage.setItem(`intercom.pane.${key}`, String(width));
    } catch {
      // not remembered
    }
  }, [key, width]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - start.current.x;
    setWidth(clamp(start.current.w + (edge === 'right' ? dx : -dx)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') setWidth((w) => clamp(w + (edge === 'right' ? -step : step)));
    else if (e.key === 'ArrowRight') setWidth((w) => clamp(w + (edge === 'right' ? step : -step)));
    else return;
    e.preventDefault();
  };

  return {
    width,
    dragging,
    handleProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick: () => setWidth(initial),
    },
  };
}

/** The handle between a side pane and the rest of the page (see `useResizableWidth`). */
export function ResizeHandle({
  props,
  dragging,
  label,
  testId,
}: {
  props: ReturnType<typeof useResizableWidth>['handleProps'];
  dragging: boolean;
  label: string;
  testId?: string;
}) {
  const s = useStyles();
  return (
    <div
      {...props}
      aria-label={label}
      title={label}
      className={mergeClasses(s.handle, dragging && s.dragging)}
      data-testid={testId}
    />
  );
}

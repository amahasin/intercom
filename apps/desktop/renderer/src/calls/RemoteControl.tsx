import { useEffect, useRef, useState } from 'react';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { Cursor20Regular } from '@fluentui/react-icons';
import { Avatar } from '@fluentui/react-components';
import { avatarSrc, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { NoticeRow } from './CallStatus.tsx';
import {
  answerControl,
  clearRemoteNotice,
  releaseControl,
  sendControlInput,
  useRemote,
} from './remote.ts';

const useStyles = makeStyles({
  tag: {
    position: 'absolute',
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'flex-start',
    zIndex: 6,
    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))',
  },
  tagAvatar: { marginLeft: '-2px', marginTop: '10px' },
  layer: {
    position: 'absolute',
    inset: 0,
    cursor: 'none',
    outline: `3px solid ${tokens.colorPaletteMarigoldBorder2}`,
    outlineOffset: '-3px',
    borderRadius: tokens.borderRadiusLarge,
  },
});

/**
 * The sharer's request ("X wants to control your screen"): the first card of the call's notices,
 * since it has to be answered, with both answers in full view.
 */
export function RemotePrompt() {
  const phase = useRemote((st) => st.phase);
  const peer = useRemote((st) => st.peer);
  if (phase !== 'asked') return null;
  const peerName = peer ? displayName(peer) : '';
  return (
    <NoticeRow
      tone="live"
      role="alertdialog"
      icon={<Cursor20Regular />}
      testId="rc-asked"
      actions={
        <>
          <Button onClick={() => void answerControl(false)} data-testid="rc-deny">
            {strings.remote.deny}
          </Button>
          <Button
            appearance="primary"
            onClick={() => void answerControl(true)}
            data-testid="rc-allow"
          >
            {strings.remote.giveControl}
          </Button>
        </>
      }
    >
      <strong>{strings.remote.wantsControl(peerName)}</strong>
    </NoticeRow>
  );
}

/**
 * Remote control as a row under the call's control bar (see CallStatus): "X is controlling your
 * screen" with Stop, "Asking X...", "You are controlling X's screen" with Release, and how a
 * request ended.
 */
export function RemoteNotice() {
  const phase = useRemote((st) => st.phase);
  const peer = useRemote((st) => st.peer);
  const notice = useRemote((st) => st.notice);
  const peerName = peer ? displayName(peer) : '';
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(clearRemoteNotice, 6_000);
    return () => window.clearTimeout(t);
  }, [notice]);
  if (phase === 'controlled')
    return (
      <NoticeRow
        tone="live"
        icon={<Cursor20Regular />}
        testId="rc-controlled"
        actions={
          <Button appearance="primary" onClick={releaseControl} data-testid="rc-stop">
            {strings.remote.stop}
          </Button>
        }
      >
        <strong>{strings.remote.controlled(peerName)}</strong>
      </NoticeRow>
    );
  if (phase === 'asking')
    return (
      <NoticeRow
        icon={<Cursor20Regular />}
        testId="rc-asking"
        actions={
          <Button onClick={releaseControl} data-testid="rc-cancel">
            {strings.remote.cancel}
          </Button>
        }
      >
        {strings.remote.asking(peerName)}
      </NoticeRow>
    );
  if (phase === 'controlling')
    return (
      <NoticeRow
        tone="live"
        icon={<Cursor20Regular />}
        testId="rc-controlling"
        actions={
          <Button appearance="primary" onClick={releaseControl} data-testid="rc-release">
            {strings.remote.release}
          </Button>
        }
      >
        <strong>{strings.remote.controlling(peerName)}</strong>
      </NoticeRow>
    );
  if (!notice) return null;
  return (
    <NoticeRow
      testId="rc-notice"
      onDismiss={clearRemoteNotice}
      dismissLabel={strings.remote.dismiss}
    >
      {notice}
    </NoticeRow>
  );
}

/**
 * Sits over the shared screen while this user controls it: turns the mouse and keyboard
 * into events for the sharer, with positions as fractions of the shared picture.
 */
export function ControlLayer() {
  const s = useStyles();
  const layer = useRef<HTMLDivElement>(null);
  const selfId = useApp((st) => st.identity?.userId);
  // The controller's own pointer, drawn here with their avatar (the real pointer is hidden).
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    el.focus();
    let frame = 0;
    let last: { x: number; y: number } | null = null;
    /** Where on the picture (0..1) a pointer is, allowing for the bars around a "contain" fit. */
    const place = (clientX: number, clientY: number): { x: number; y: number } | null => {
      const video = el.parentElement?.querySelector('video');
      const box = el.getBoundingClientRect();
      const vw = video?.videoWidth || box.width;
      const vh = video?.videoHeight || box.height;
      const scale = Math.min(box.width / vw, box.height / vh);
      const w = vw * scale;
      const h = vh * scale;
      const x = (clientX - box.left - (box.width - w) / 2) / w;
      const y = (clientY - box.top - (box.height - h) / 2) / h;
      return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
    };
    const move = (e: PointerEvent) => {
      const box = el.getBoundingClientRect();
      setMouse({ x: e.clientX - box.left, y: e.clientY - box.top });
      const p = place(e.clientX, e.clientY);
      if (!p) return;
      last = p;
      if (frame) return;
      // At most one move per frame.
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (last) sendControlInput({ k: 'move', ...last });
      });
    };
    const button = (isDown: boolean) => (e: PointerEvent) => {
      const p = place(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      el.focus();
      sendControlInput({ k: isDown ? 'down' : 'up', b: e.button, ...p });
    };
    const down = button(true);
    const up = button(false);
    const wheel = (e: WheelEvent) => {
      const p = place(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      sendControlInput({ k: 'wheel', dx: e.deltaX, dy: e.deltaY, ...p });
    };
    const key = (isDown: boolean) => (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.repeat && !isDown) return;
      sendControlInput({ k: 'key', code: e.code, down: isDown });
    };
    const keyDown = key(true);
    const keyUp = key(false);
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('keydown', keyDown);
    el.addEventListener('keyup', keyUp);
    el.addEventListener('contextmenu', menu);
    const leave = () => setMouse(null);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointerleave', leave);
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('keydown', keyDown);
      el.removeEventListener('keyup', keyUp);
      el.removeEventListener('contextmenu', menu);
    };
  }, []);

  return (
    <div ref={layer} className={s.layer} tabIndex={0} data-testid="rc-layer">
      {mouse && <PointerTag x={mouse.x} y={mouse.y} userId={selfId} fill="#ffffff" />}
    </div>
  );
}

/** An arrow pointer with a small avatar beside it, so whose pointer it is can be told at a glance. */
function PointerTag({
  x,
  y,
  userId,
  fill,
}: {
  x: number;
  y: number;
  userId: string | undefined;
  fill: string;
}) {
  const s = useStyles();
  const person = useApp((st) => (userId ? st.people[userId] : undefined));
  const self = useApp((st) => st.identity);
  const mine = userId !== undefined && userId === self?.userId;
  const name = userId ? (mine ? (self?.displayName ?? '') : displayName(userId)) : '';
  const avatar = mine ? self?.avatarHash : person?.avatarHash;
  return (
    <div
      className={s.tag}
      style={{ left: x, top: y }}
      title={name}
      data-testid="pointer-tag"
      data-user={userId}
    >
      <svg width="16" height="22" viewBox="0 0 16 22" aria-hidden="true">
        <path
          d="M1 1 L1 17 L5.2 13.2 L8.2 20 L10.8 18.9 L7.9 12.2 L13.5 12.2 Z"
          fill={fill}
          stroke="#ffffff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <Avatar
        className={s.tagAvatar}
        name={name}
        size={20}
        color="colorful"
        image={avatarSrc(avatar)}
      />
    </div>
  );
}

/** Where a fraction of the shared picture is, in the box that shows it (the picture is letterboxed). */
function contentRect(box: HTMLElement) {
  const video = box.querySelector('video');
  const b = box.getBoundingClientRect();
  const vw = video?.videoWidth || b.width;
  const vh = video?.videoHeight || b.height;
  const scale = Math.min(b.width / vw, b.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: (b.width - w) / 2, top: (b.height - h) / 2, width: w, height: h };
}

/**
 * The shared pointer, over the shared screen, for everyone watching it: the avatar beside it is
 * whoever has their hand on it (the person sharing, or the colleague controlling).
 */
export function SharedPointers({ sharerId }: { sharerId: string }) {
  const pointer = useRemote((st) => st.pointer);
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<ReturnType<typeof contentRect> | undefined>();
  // The picture's place in its box changes with the window and the stream: look again now and then.
  useEffect(() => {
    const update = () => {
      const el = box.current?.parentElement;
      if (!el) return;
      const next = contentRect(el);
      setRect((old) =>
        old && old.left === next.left && old.top === next.top && old.width === next.width
          ? old
          : next,
      );
    };
    update();
    const t = window.setInterval(update, 400);
    return () => window.clearInterval(t);
  }, [pointer]);
  return (
    <div
      ref={box}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
      data-testid="shared-pointers"
    >
      {pointer && rect && (
        <PointerTag
          x={rect.left + pointer.x * rect.width}
          y={rect.top + pointer.y * rect.height}
          userId={pointer.by === 'controller' ? pointer.user : sharerId}
          fill={pointer.by === 'controller' ? '#ffffff' : '#1b1a19'}
        />
      )}
    </div>
  );
}

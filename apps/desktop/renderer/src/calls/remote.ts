/**
 * Remote control of a shared screen, like Teams: a participant asks the person sharing for
 * control, the sharer allows or declines, and while allowed the controller's mouse and
 * keyboard drive the shared screen. Requests, answers and input travel over a data channel
 * of the call (peer to peer; it is DTLS-protected and bound to the signed session
 * description, so it comes from the person it claims to). The sharer's main process turns the
 * input into real input, and refuses anything its own checks do not allow.
 *
 * Only a whole screen can be controlled, and only in calls that connect people directly
 * (not the host relay).
 */
import { create } from 'zustand';
import { strings } from '../strings.ts';

export type RemotePhase =
  /** Nothing going on. */
  | 'idle'
  /** This user asked for control and waits for the answer. */
  | 'asking'
  /** This user controls the peer's screen. */
  | 'controlling'
  /** The peer asked to control the screen this user shares; waiting for Allow or Deny. */
  | 'asked'
  /** The peer controls the screen this user shares. */
  | 'controlled';

/** Where the shared pointer is, for everyone looking at the shared screen. */
export interface SharedPointer {
  x: number;
  y: number;
  /** Whose hand is on it right now. */
  by: 'controller' | 'sharer';
  /** The person controlling, when `by` is the controller. */
  user: string | undefined;
  at: number;
}

interface RemoteUi {
  phase: RemotePhase;
  peer: string | undefined;
  /** A short message about how the last request ended. */
  notice: string | undefined;
  /** The shared pointer while somebody is controlling (it fades out when updates stop). */
  pointer: SharedPointer | undefined;
}

export const useRemote = create<RemoteUi>(() => ({
  phase: 'idle',
  peer: undefined,
  notice: undefined,
  pointer: undefined,
}));

const set = (patch: Partial<RemoteUi>) => useRemote.setState(patch);
const channels = new Map<string, RTCDataChannel>();
/** What this user is sharing, if anything: control needs a whole screen. */
let shareKind: 'screen' | 'window' | null = null;
let timer: number | undefined;

/** A request waits this long for an answer. */
const ASK_TIMEOUT_MS = 30_000;
const MAX_BUFFERED = 64 * 1024;

type Message =
  | { t: 'request' }
  | { t: 'grant' }
  | { t: 'deny'; why: 'no' | 'busy' | 'unavailable' | 'timeout'; detail?: string }
  | { t: 'ptr'; x: number; y: number; by: 'controller' | 'sharer'; user?: string }
  | { t: 'release' }
  | { t: 'revoke' }
  | { t: 'in'; e: unknown };

let nameOf: (userId: string) => string = (id) => id;
let isSharing: (userId: string) => boolean = () => false;
/** The engine says how to show a person's name and who is sharing (it owns the call's people). */
export function setRemoteContext(context: {
  name: (userId: string) => string;
  sharing: (userId: string) => boolean;
}): void {
  nameOf = context.name;
  isSharing = context.sharing;
}

let pointerFade: number | undefined;
let lastPointerSent = 0;
const POINTER_FADE_MS = 1_800;
/** The pointer goes to the others at most this often. */
const POINTER_INTERVAL_MS = 40;

/** Start listening for what main reports while this user's shared screen is being controlled. */
export function initRemote(): void {
  window.officemeshWindow?.onRemoteCursor((cursor) => {
    const { phase, peer } = useRemote.getState();
    if (phase !== 'controlled') return;
    const now = Date.now();
    if (now - lastPointerSent < POINTER_INTERVAL_MS) return;
    lastPointerSent = now;
    const message: Message = {
      t: 'ptr',
      x: cursor.x,
      y: cursor.y,
      by: cursor.by,
      ...(cursor.by === 'controller' && peer && { user: peer }),
    };
    for (const channel of channels.values())
      if (channel.readyState === 'open') channel.send(JSON.stringify(message));
  });
  window.officemeshWindow?.onRemoteFailed((reason) => {
    if (useRemote.getState().phase === 'controlled') endControl(strings.remote.failed(reason));
  });
}

function showPointer(pointer: Omit<SharedPointer, 'at'>): void {
  window.clearTimeout(pointerFade);
  set({ pointer: { ...pointer, at: Date.now() } });
  pointerFade = window.setTimeout(() => set({ pointer: undefined }), POINTER_FADE_MS);
}

function post(userId: string, message: Message): void {
  const channel = channels.get(userId);
  if (channel?.readyState !== 'open') return;
  // Pointer moves are only worth sending while the channel keeps up.
  if (message.t === 'in' && channel.bufferedAmount > MAX_BUFFERED) return;
  channel.send(JSON.stringify(message));
}

function clearTimer(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
}

function idle(notice?: string): void {
  clearTimer();
  set({ phase: 'idle', peer: undefined, notice });
}

/** This user shares a screen, a window or nothing (null). Either can be controlled. */
export function setShareKind(kind: 'screen' | 'window' | null): void {
  shareKind = kind;
  if (kind === null) endControl();
}

export function attachControl(userId: string, channel: RTCDataChannel): void {
  channels.set(userId, channel);
  channel.onmessage = (event) => onMessage(userId, event.data);
}

export function detachControl(userId: string): void {
  channels.delete(userId);
  if (useRemote.getState().peer === userId) endControl(strings.remote.connectionLost);
}

/** The call or the share ended, or the person left: nothing is controlled any more. */
export function endControl(notice?: string): void {
  const { phase, peer } = useRemote.getState();
  if (phase === 'controlled') void window.officemeshWindow?.remoteControl(false);
  if (peer && (phase === 'controlled' || phase === 'asked')) post(peer, { t: 'revoke' });
  if (peer && (phase === 'controlling' || phase === 'asking')) post(peer, { t: 'release' });
  if (phase !== 'idle') idle(notice);
  window.clearTimeout(pointerFade);
  set({ pointer: undefined });
}

function onMessage(from: string, raw: unknown): void {
  if (typeof raw !== 'string' || raw.length > 4_096) return;
  let message: Message;
  try {
    message = JSON.parse(raw) as Message;
  } catch {
    return;
  }
  const state = useRemote.getState();
  switch (message.t) {
    case 'request':
      if (state.phase !== 'idle') {
        post(from, { t: 'deny', why: 'busy' });
      } else if (shareKind === null) {
        post(from, { t: 'deny', why: 'unavailable', detail: 'nothing is being shared' });
      } else {
        set({ phase: 'asked', peer: from, notice: undefined });
        // The sharer may be working in another window: make the question impossible to miss.
        window.officemeshWindow?.attention();
        clearTimer();
        timer = window.setTimeout(() => answerControl(false, 'timeout'), ASK_TIMEOUT_MS);
      }
      return;
    case 'grant':
      if (state.phase === 'asking' && state.peer === from) {
        clearTimer();
        set({ phase: 'controlling', notice: undefined });
      }
      return;
    case 'deny':
      if (state.phase === 'asking' && state.peer === from) {
        idle(
          message.why === 'busy'
            ? strings.remote.busy(nameOf(from))
            : message.why === 'unavailable'
              ? strings.remote.unavailable(nameOf(from), message.detail ?? '')
              : message.why === 'timeout'
                ? strings.remote.noAnswer(nameOf(from))
                : strings.remote.declined(nameOf(from)),
        );
      }
      return;
    case 'ptr':
      // Where the shared pointer is: only the person sharing says so.
      if (
        isSharing(from) &&
        Number.isFinite(message.x) &&
        Number.isFinite(message.y) &&
        (message.by === 'controller' || message.by === 'sharer')
      )
        showPointer({
          x: Math.min(1, Math.max(0, message.x)),
          y: Math.min(1, Math.max(0, message.y)),
          by: message.by,
          user: typeof message.user === 'string' ? message.user : undefined,
        });
      return;
    case 'release':
      if ((state.phase === 'controlled' || state.phase === 'asked') && state.peer === from) {
        if (state.phase === 'controlled') void window.officemeshWindow?.remoteControl(false);
        idle(strings.remote.released(nameOf(from)));
      }
      return;
    case 'revoke':
      if (state.phase === 'controlling' && state.peer === from)
        idle(strings.remote.revoked(nameOf(from)));
      return;
    case 'in':
      // Only the person who was allowed, and only while allowed.
      if (state.phase === 'controlled' && state.peer === from)
        window.officemeshWindow?.remoteInput(message.e);
      return;
  }
}

/** Ask the person sharing their screen to let this user control it. */
export function requestControl(peer: string): void {
  if (useRemote.getState().phase !== 'idle') return;
  set({ phase: 'asking', peer, notice: undefined });
  post(peer, { t: 'request' });
  clearTimer();
  timer = window.setTimeout(() => {
    if (useRemote.getState().phase === 'asking') {
      post(peer, { t: 'release' });
      idle(strings.remote.noAnswer(nameOf(peer)));
    }
  }, ASK_TIMEOUT_MS + 2_000);
}

/** The sharer answers a request. */
export async function answerControl(allow: boolean, why: 'no' | 'timeout' = 'no'): Promise<void> {
  const { phase, peer } = useRemote.getState();
  if (phase !== 'asked' || !peer) return;
  clearTimer();
  if (!allow || shareKind === null) {
    post(peer, { t: 'deny', why });
    idle();
    return;
  }
  // Allowed: first make sure input can really be delivered on this PC, and only then say yes.
  const result = (await window.officemeshWindow?.remoteControl(true)) ?? {
    ok: false,
    reason: 'this window cannot control the screen',
  };
  if (useRemote.getState().phase !== 'asked') {
    void window.officemeshWindow?.remoteControl(false);
    return;
  }
  if (!result.ok) {
    post(peer, { t: 'deny', why: 'unavailable', detail: result.reason ?? '' });
    idle(strings.remote.failed(result.reason ?? ''));
    return;
  }
  post(peer, { t: 'grant' });
  set({ phase: 'controlled' });
}

/** Stop: the controller lets go, or the sharer takes control back. */
export function releaseControl(): void {
  endControl();
}

/** Send one mouse or keyboard event to the screen being controlled. */
export function sendControlInput(event: unknown): void {
  const { phase, peer } = useRemote.getState();
  if (phase === 'controlling' && peer) post(peer, { t: 'in', e: event });
}

export function clearRemoteNotice(): void {
  set({ notice: undefined });
}

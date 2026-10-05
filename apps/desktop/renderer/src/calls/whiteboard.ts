/**
 * The meeting whiteboard (plan section 9): a Yjs document per call, synced over a WebRTC
 * data channel to every participant. Concurrent drawing merges the same way everywhere.
 */
import * as Y from 'yjs';
import { create } from 'zustand';

export type WhiteboardTool = 'pen' | 'rect' | 'ellipse' | 'text' | 'note';

/** One drawn item. Strokes keep their points in a Y.Array so they grow live. */
export interface WhiteboardItem {
  id: string;
  kind: 'stroke' | 'rect' | 'ellipse' | 'text' | 'note';
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  points: number[];
}

/** Data channel messages are kept under Chromium's 256 KB limit by splitting updates. */
const CHUNK = 64 * 1024;
const WHOLE = 0;
const PART = 1;
const LAST = 2;

let doc = new Y.Doc();
const channels = new Map<string, RTCDataChannel>();
const partial = new Map<string, Uint8Array[]>();

/** Bumped whenever the document changes, so React re-renders the board. */
export const useWhiteboard = create<{ version: number; open: boolean }>(() => ({
  version: 0,
  open: false,
}));

function items(): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>('items');
}

function send(channel: RTCDataChannel, update: Uint8Array): void {
  if (channel.readyState !== 'open') return;
  if (update.length + 1 <= CHUNK) {
    const msg = new Uint8Array(update.length + 1);
    msg[0] = WHOLE;
    msg.set(update, 1);
    channel.send(msg);
    return;
  }
  for (let i = 0; i < update.length; i += CHUNK) {
    const part = update.subarray(i, i + CHUNK);
    const msg = new Uint8Array(part.length + 1);
    msg[0] = i + CHUNK >= update.length ? LAST : PART;
    msg.set(part, 1);
    channel.send(msg);
  }
}

function receive(userId: string, data: ArrayBuffer): void {
  const bytes = new Uint8Array(data);
  const kind = bytes[0];
  const body = bytes.subarray(1);
  if (kind === WHOLE) {
    Y.applyUpdate(doc, body, 'remote');
    return;
  }
  const parts = partial.get(userId) ?? [];
  parts.push(body.slice());
  if (kind === PART) {
    partial.set(userId, parts);
    return;
  }
  partial.delete(userId);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const whole = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    whole.set(p, at);
    at += p.length;
  }
  Y.applyUpdate(doc, whole, 'remote');
}

function listen(): void {
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    useWhiteboard.setState((s) => ({ version: s.version + 1 }));
    // Our own changes go to everyone; remote ones came from their author directly (mesh).
    if (origin === 'remote') return;
    for (const ch of channels.values()) send(ch, update);
  });
}
listen();

/** A participant's whiteboard channel: on opening, each side sends its whole document. */
export function attachWhiteboard(userId: string, channel: RTCDataChannel): void {
  channel.binaryType = 'arraybuffer';
  channels.set(userId, channel);
  channel.onmessage = (e) => receive(userId, e.data as ArrayBuffer);
  const sync = () => send(channel, Y.encodeStateAsUpdate(doc));
  if (channel.readyState === 'open') sync();
  else channel.onopen = sync;
}

export function detachWhiteboard(userId: string): void {
  channels.delete(userId);
  partial.delete(userId);
}

/** A new call starts with an empty board. */
export function resetWhiteboard(): void {
  channels.clear();
  partial.clear();
  doc.destroy();
  doc = new Y.Doc();
  listen();
  useWhiteboard.setState((s) => ({ version: s.version + 1, open: false }));
}

export function setWhiteboardOpen(open: boolean): void {
  useWhiteboard.setState({ open });
}

export function whiteboardItems(): WhiteboardItem[] {
  return items()
    .toArray()
    .map((m) => ({
      id: m.get('id') as string,
      kind: m.get('kind') as WhiteboardItem['kind'],
      color: (m.get('color') as string) ?? '#000000',
      x: (m.get('x') as number) ?? 0,
      y: (m.get('y') as number) ?? 0,
      w: (m.get('w') as number) ?? 0,
      h: (m.get('h') as number) ?? 0,
      text: (m.get('text') as string) ?? '',
      points: ((m.get('points') as Y.Array<number> | undefined)?.toArray() ?? []) as number[],
    }));
}

/** Start a pen stroke; returns a function that extends it. */
export function beginStroke(color: string, x: number, y: number): (x: number, y: number) => void {
  const map = new Y.Map<unknown>();
  const points = new Y.Array<number>();
  doc.transact(() => {
    map.set('id', crypto.randomUUID());
    map.set('kind', 'stroke');
    map.set('color', color);
    points.push([x, y]);
    map.set('points', points);
    items().push([map]);
  });
  return (px, py) => points.push([px, py]);
}

export function addShape(item: Omit<WhiteboardItem, 'id' | 'points'>): void {
  const map = new Y.Map<unknown>();
  doc.transact(() => {
    map.set('id', crypto.randomUUID());
    for (const [k, v] of Object.entries(item)) map.set(k, v);
    items().push([map]);
  });
}

export function clearWhiteboard(): void {
  doc.transact(() => items().delete(0, items().length));
}

/** The document as plain JSON, for tests: every participant must see the same. */
export function whiteboardJson(): string {
  return JSON.stringify(whiteboardItems());
}

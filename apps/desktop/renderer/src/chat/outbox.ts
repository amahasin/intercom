/**
 * Files on their way. Pressing Send takes the files out of the composer at once and puts each one
 * in the chat as a message of its own, still to be prepared (read and fingerprinted on this PC,
 * which is what takes the time for a big file). When the core has the real message, it replaces
 * this one. Nothing here is sent to anyone: it is only what this window shows meanwhile.
 */
import { create } from 'zustand';
import type { MsgRef } from '@officemesh/protocol';
import { act, core } from '../state.ts';
import { composerKey, useAttachments, type Attachment } from './attachments.ts';

export interface PendingSend {
  /** The attachment's id, which is also what the core reports progress under. */
  id: string;
  convId: string;
  thread: MsgRef | undefined;
  /** One composer's worth: the conversation, or a channel thread. */
  key: string;
  attachment: Attachment;
  text: string | undefined;
  urgent: boolean;
  replyTo: MsgRef | undefined;
  /** When Send was pressed; the time shown over the message. */
  at: number;
  state: 'waiting' | 'preparing' | 'failed';
  error: string | undefined;
}

interface OutboxState {
  items: PendingSend[];
}

export const useOutbox = create<OutboxState>(() => ({ items: [] }));

const patch = (id: string, change: Partial<PendingSend>) =>
  useOutbox.setState((s) => ({
    items: s.items.map((p) => (p.id === id ? { ...p, ...change } : p)),
  }));

function discard(id: string): void {
  const gone = useOutbox.getState().items.find((p) => p.id === id);
  if (gone?.attachment.previewUrl) URL.revokeObjectURL(gone.attachment.previewUrl);
  useOutbox.setState((s) => ({ items: s.items.filter((p) => p.id !== id) }));
  useAttachments.setState((s) => {
    const preparing = { ...s.preparing };
    delete preparing[id];
    return { preparing };
  });
}

/** JPEG thumbnail (max 320 px) for images, made on this PC. */
async function thumbnail(
  file: Blob,
): Promise<{ thumb: string; width: number; height: number } | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const thumb = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (thumb.length > 48_000) return undefined;
    return { thumb, width: bitmap.width, height: bitmap.height };
  } catch {
    return undefined;
  }
}

/**
 * Share one file as its own message (with the caption, if any). A file on disk is shared from
 * where it is; only a pasted picture, which has no file, is read into memory.
 */
async function share(p: PendingSend): Promise<void> {
  const a = p.attachment;
  const thumb = a.mime.startsWith('image/') ? await thumbnail(a.file) : undefined;
  const base = {
    convId: p.convId,
    name: a.name,
    ...(a.mime && { mime: a.mime }),
    ...(p.text && { text: p.text }),
    ...(p.urgent && { urgent: true }),
    ...(p.thread && { thread: p.thread }),
    ...(p.replyTo && { replyTo: p.replyTo }),
    ...thumb,
  };
  await act(p.convId, async () =>
    a.path
      ? core.invoke('files.share', { ...base, path: a.path, prepareId: a.id })
      : core.invoke('files.share', { ...base, data: new Uint8Array(await a.file.arrayBuffer()) }),
  );
}

/** One file at a time per composer, so the messages come out in the order they were queued. */
const tails = new Map<string, Promise<void>>();

function schedule(p: PendingSend): void {
  const run = async () => {
    // Taken out by the user while it waited.
    if (!useOutbox.getState().items.some((i) => i.id === p.id)) return;
    patch(p.id, { state: 'preparing', error: undefined });
    try {
      await share(p);
      discard(p.id);
    } catch (err) {
      patch(p.id, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  };
  tails.set(p.key, (tails.get(p.key) ?? Promise.resolve()).then(run, run));
}

/** Put the files in the chat now and start preparing them; the caption goes with the first. */
export function sendFiles(
  convId: string,
  files: Attachment[],
  extra: {
    text?: string | undefined;
    urgent?: boolean;
    thread?: MsgRef | undefined;
    replyTo?: MsgRef | undefined;
  },
): void {
  const key = composerKey(convId, extra.thread);
  const at = Date.now();
  const items = files.map<PendingSend>((attachment, i) => ({
    id: attachment.id,
    convId,
    thread: extra.thread,
    key,
    attachment,
    text: i === 0 ? extra.text : undefined,
    urgent: extra.urgent === true,
    replyTo: i === 0 ? extra.replyTo : undefined,
    at,
    state: 'waiting',
    error: undefined,
  }));
  useOutbox.setState((s) => ({ items: [...s.items, ...items] }));
  for (const p of items) schedule(p);
}

export function retrySend(id: string): void {
  const p = useOutbox.getState().items.find((i) => i.id === id);
  if (!p || p.state !== 'failed') return;
  patch(id, { state: 'waiting', error: undefined });
  schedule({ ...p, state: 'waiting', error: undefined });
}

export function dismissSend(id: string): void {
  discard(id);
}

/** What is still on its way in one composer's place (a conversation, or a channel thread). */
export function usePendingCount(convId: string, thread?: MsgRef): number {
  const key = composerKey(convId, thread);
  return useOutbox((s) => s.items.filter((p) => p.key === key).length);
}

/**
 * Files waiting in a composer. Attaching, pasting or dropping a file only queues it here
 * (nothing is read or sent); the files go out with the message when the user presses Send.
 * A queued file is just a reference to where it already is on disk: no copy is made.
 */
import { create } from 'zustand';
import { MAX_FILE_BYTES, type MsgRef } from '@officemesh/protocol';

/** Pasted pictures have no file on disk; their bytes travel through the app (see the core). */
export const PASTE_LIMIT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** Pictures up to this size get a preview in the composer. */
const PREVIEW_LIMIT_BYTES = 40 * 1024 * 1024;

export interface Attachment {
  id: string;
  file: File;
  name: string;
  size: number;
  mime: string;
  /** Where the file is on disk; empty for a pasted picture. */
  path: string;
  /** An object URL for the picture preview (a reference to the file, not a copy). */
  previewUrl: string | undefined;
}

interface AttachmentState {
  byKey: Record<string, Attachment[]>;
  /** Why a file was not added, or why sending failed, per composer. */
  notice: Record<string, string | undefined>;
  /** Hashing progress while a file is being prepared, by attachment id (see outbox.ts). */
  preparing: Record<string, { done: number; total: number }>;
  add(key: string, files: File[]): void;
  remove(key: string, id: string): void;
  clear(key: string): void;
  /** Hand the queued files over to be sent: they leave the composer but stay usable. */
  take(key: string): Attachment[];
  setNotice(key: string, text: string | undefined): void;
}

/** One composer per conversation, and one per channel thread. */
export const composerKey = (convId: string, thread?: MsgRef): string =>
  thread ? `${convId}|${thread.author}:${thread.seq}` : convId;

let nextId = 1;

function pastedName(file: File): string {
  const ext = (file.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg');
  return `pasted-${Date.now()}.${ext}`;
}

export const useAttachments = create<AttachmentState>((set, get) => ({
  byKey: {},
  notice: {},
  preparing: {},
  add: (key, files) => {
    const current = get().byKey[key] ?? [];
    const added: Attachment[] = [];
    let notice: string | undefined;
    for (const file of files) {
      const path = window.officemesh.pathForFile(file);
      const name = file.name || pastedName(file);
      const duplicate = [...current, ...added].some(
        (a) => (path ? a.path === path : false) || (!path && !a.path && a.file === file),
      );
      if (duplicate) continue;
      if (current.length + added.length >= MAX_ATTACHMENTS) {
        notice = `You can send up to ${MAX_ATTACHMENTS} files at once.`;
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        notice = `${name} is larger than 4 TB, which is the most InterCom can send.`;
        continue;
      }
      if (!path && file.size > PASTE_LIMIT_BYTES) {
        notice = `${name} is too large to paste. Attach the file instead.`;
        continue;
      }
      const isPicture = /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type);
      added.push({
        id: `att${nextId++}`,
        file,
        name,
        size: file.size,
        mime: file.type,
        path,
        previewUrl:
          isPicture && file.size <= PREVIEW_LIMIT_BYTES ? URL.createObjectURL(file) : undefined,
      });
    }
    set((s) => ({
      byKey: added.length ? { ...s.byKey, [key]: [...current, ...added] } : s.byKey,
      notice: { ...s.notice, [key]: notice },
    }));
  },
  remove: (key, id) => {
    const list = get().byKey[key] ?? [];
    const gone = list.find((a) => a.id === id);
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    set((s) => ({
      byKey: { ...s.byKey, [key]: list.filter((a) => a.id !== id) },
      notice: { ...s.notice, [key]: undefined },
    }));
  },
  clear: (key) => {
    for (const a of get().byKey[key] ?? []) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    set((s) => {
      const byKey = { ...s.byKey };
      delete byKey[key];
      return { byKey, notice: { ...s.notice, [key]: undefined } };
    });
  },
  take: (key) => {
    const taken = get().byKey[key] ?? [];
    set((s) => {
      const byKey = { ...s.byKey };
      delete byKey[key];
      return { byKey, notice: { ...s.notice, [key]: undefined } };
    });
    return taken;
  },
  setNotice: (key, text) => set((s) => ({ notice: { ...s.notice, [key]: text } })),
}));

/** Queue files in a composer (the conversation's main one, or a channel thread's). */
export function queueFiles(convId: string, files: File[], thread?: MsgRef): void {
  useAttachments.getState().add(composerKey(convId, thread), files);
}

/**
 * The Files page filters by what a file is, in the words people use: pictures, documents, audio and
 * video, archives. It goes by the name first (senders often give a generic type), then the type.
 */
import type { FileListItem } from '@officemesh/protocol/ipc';
import { previewKind } from '../preview/kinds.ts';

export const FILE_GROUPS = ['pictures', 'documents', 'media', 'archives', 'other'] as const;
export type FileGroup = (typeof FILE_GROUPS)[number];

const ARCHIVE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|cab|iso)$/i;
const DOCUMENT =
  /\.(docx?|dotx?|xlsx?|xlsm|pptx?|potx?|pdf|rtf|odt|ods|odp|txt|md|csv|tsv|json|xml|log)$/i;
const MEDIA = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|wma|mp4|m4v|mov|avi|mkv|webm|wmv)$/i;
const PICTURE = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|heic|ico)$/i;

export function fileGroup(file: Pick<FileListItem, 'name' | 'mime'>): FileGroup {
  if (ARCHIVE.test(file.name) || /^application\/(zip|x-7z|x-rar|gzip|x-tar)/.test(file.mime))
    return 'archives';
  if (PICTURE.test(file.name) || file.mime.startsWith('image/')) return 'pictures';
  if (MEDIA.test(file.name) || /^(audio|video)\//.test(file.mime)) return 'media';
  const kind = previewKind(file);
  if (kind === 'image') return 'pictures';
  if (kind === 'audio' || kind === 'video') return 'media';
  if (kind || DOCUMENT.test(file.name) || /^application\/(pdf|msword|vnd\.)/.test(file.mime))
    return 'documents';
  return 'other';
}

export interface FileFilter {
  /** What the person typed: matches the name, who shared it and where. */
  text: string;
  group: FileGroup | 'all';
  /** A sender's user ID, `me`, or `anyone`. */
  from: string;
}

export const NO_FILTER: FileFilter = { text: '', group: 'all', from: 'anyone' };

/** The files that pass the filter, in the order given. `selfId` is what `me` stands for. */
export function filterFiles(
  items: FileListItem[],
  filter: FileFilter,
  selfId: string | undefined,
  nameOf: (userId: string) => string,
): FileListItem[] {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((f) => {
    if (filter.group !== 'all' && fileGroup(f) !== filter.group) return false;
    if (
      filter.from === 'me'
        ? f.author !== selfId
        : filter.from !== 'anyone' && f.author !== filter.from
    )
      return false;
    if (words.length === 0) return true;
    const haystack = `${f.name} ${nameOf(f.author)} ${f.conversation}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

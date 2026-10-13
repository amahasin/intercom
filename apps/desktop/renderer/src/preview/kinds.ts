import type { FileRef } from '@officemesh/protocol';

/** What the viewer needs to know about a file (a chat message's file or a row of the Files list). */
export type PreviewFile = Pick<FileRef, 'sha256' | 'name' | 'size' | 'mime'>;

/** The kinds of file InterCom can show without leaving the app. */
export type PreviewKind =
  'image' | 'pdf' | 'video' | 'audio' | 'text' | 'csv' | 'docx' | 'xlsx' | 'pptx';

const BY_EXTENSION: Record<string, PreviewKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  pdf: 'pdf',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  csv: 'csv',
  tsv: 'csv',
  docx: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  pptx: 'pptx',
};

const TEXT_EXTENSIONS = [
  'txt',
  'log',
  'md',
  'markdown',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'ini',
  'cfg',
  'conf',
  'toml',
  'env',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'sh',
  'bat',
  'cmd',
  'ps1',
  'sql',
  'srt',
  'vtt',
  'gitignore',
  'tex',
  'rtf',
];
for (const e of TEXT_EXTENSIONS) BY_EXTENSION[e] = 'text';

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** What a file can be shown as, going by its name first (senders often give a generic type). */
export function previewKind(file: Pick<PreviewFile, 'name' | 'mime'>): PreviewKind | undefined {
  const kind = BY_EXTENSION[extensionOf(file.name)];
  if (kind) {
    // A video the page's player cannot open is not worth a preview.
    if (kind === 'video') return /^video\/(mp4|webm)$/.test(file.mime) ? 'video' : undefined;
    return kind;
  }
  if (/^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.test(file.mime)) return 'image';
  if (file.mime === 'application/pdf') return 'pdf';
  if (/^video\/(mp4|webm)$/.test(file.mime)) return 'video';
  if (/^audio\/(mpeg|wav|x-wav|ogg|webm|mp4|aac|flac|x-m4a)$/.test(file.mime)) return 'audio';
  if (/^text\/(plain|markdown|x-log)$/.test(file.mime)) return 'text';
  if (file.mime === 'application/json') return 'text';
  if (file.mime === 'text/csv') return 'csv';
  return undefined;
}

/** Bigger than this, a file of that kind is not opened in the viewer (it is read whole). */
export const MAX_PARSE_BYTES: Partial<Record<PreviewKind, number>> = {
  docx: 40 * 1024 * 1024,
  xlsx: 40 * 1024 * 1024,
  pptx: 60 * 1024 * 1024,
  text: 2 * 1024 * 1024,
  csv: 4 * 1024 * 1024,
};

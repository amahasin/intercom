import type { PreviewFile } from './kinds.ts';

/** Where the page can read a complete file from (the app serves it, with byte ranges). */
export const fileHref = (file: Pick<PreviewFile, 'sha256' | 'mime'>): string =>
  new URL(`./files/${file.sha256}?type=${encodeURIComponent(file.mime)}`, document.baseURI).href;

/** The first `max` bytes of a file (all of it when it is smaller). */
export async function readFileBytes(
  file: PreviewFile,
  max: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const response = await fetch(fileHref(file), {
    headers: file.size > max ? { Range: `bytes=0-${max - 1}` } : {},
  });
  if (!response.ok) throw new Error(`The file could not be read (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes: bytes.length > max ? bytes.subarray(0, max) : bytes, truncated: file.size > max };
}

/** Text from bytes: UTF-8, or UTF-16 when it says so; undefined when it is binary. */
export function decodeText(bytes: Uint8Array): string | undefined {
  const head = bytes.subarray(0, 4096);
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (head.includes(0)) return undefined;
  const text = new TextDecoder('utf-8').decode(bytes);
  // A byte order mark (U+FEFF) at the start is not part of the text.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Message text is a restricted Markdown subset (see docs/protocol.md): **bold**, *italic*,
 * ~~strike~~, `code`, fenced code blocks, > quotes, lists, [links](url) and mentions
 * written `@[Display name](userId)`. The core only needs plain text (search, excerpts,
 * toasts) and the mentioned userIds; rendering happens in the UI.
 */

export const MENTION_PATTERN = /@\[([^\]\n]{1,64})\]\(([a-z2-7]{32})\)/g;

export function mentionIds(md: string): string[] {
  return [...new Set([...md.matchAll(MENTION_PATTERN)].map((m) => m[2]!))];
}

export function toPlain(md: string): string {
  return md
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(MENTION_PATTERN, '@$1')
    .replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, '$1 $2')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}(?:>\s?|[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/gm, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A one-line excerpt for previews, quotes and toasts. */
export function excerpt(md: string, max = 120): string {
  const flat = toPlain(md).replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

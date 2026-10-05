const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Extensions Windows will run or interpret; such files are shown in Explorer, never opened. */
export const EXECUTABLE_EXTENSIONS = new Set([
  'exe',
  'com',
  'bat',
  'cmd',
  'msi',
  'msix',
  'msp',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'scr',
  'pif',
  'lnk',
  'url',
  'reg',
  'cpl',
  'jar',
  'appx',
  'appref-ms',
  'application',
  'dll',
  'sys',
]);

/**
 * Make a peer-supplied name safe as the last component of a path: no separators,
 * control or reserved characters, no reserved device names, bounded length.
 */
export function safeFileName(name: string): string {
  let n = name
    // Control characters are exactly what must be stripped here.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!n) n = 'file';
  if (RESERVED.test(n)) n = `_${n}`;
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

export function isExecutable(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && EXECUTABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

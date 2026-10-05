import http from 'node:http';
import { networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  excerpt,
  fetchLanPreview,
  isExecutable,
  isPrivateAddress,
  mentionIds,
  parsePreview,
  safeFileName,
  toPlain,
} from '../src/index.ts';

const BOB = 'b'.repeat(32);

describe('markdown helpers', () => {
  it('extracts plain text and mentions', () => {
    const md = `Hi @[Bob Das](${BOB}), **bold** _it_ ~~old~~ \`code\` [site](http://intranet/x)\n> quoted\n- item\n\`\`\`\nlet x = 1;\n\`\`\``;
    expect(mentionIds(md)).toEqual([BOB]);
    expect(toPlain(md)).toBe(
      'Hi @Bob Das, bold it old code site http://intranet/x\nquoted\nitem\n\nlet x = 1;',
    );
    expect(excerpt('a'.repeat(300), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});

describe('file names from peers', () => {
  it('can never escape the folder or hit device names', () => {
    expect(safeFileName('..\\..\\Windows\\system32\\evil.dll')).toBe(
      '_.._Windows_system32_evil.dll',
    );
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('CON.txt')).toBe('_CON.txt');
    expect(safeFileName('report:2026?.pdf')).toBe('report_2026_.pdf');
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName(`${'x'.repeat(300)}.docx`)).toHaveLength(120);
    expect(safeFileName(`${'x'.repeat(300)}.docx`).endsWith('.docx')).toBe(true);
  });

  it('recognises executables, which are only ever shown in Explorer', () => {
    for (const n of ['setup.exe', 'run.BAT', 'x.ps1', 'a.lnk', 'b.msi', 'c.js'])
      expect(isExecutable(n)).toBe(true);
    for (const n of ['minutes.docx', 'photo.png', 'notes.txt', 'archive.zip'])
      expect(isExecutable(n)).toBe(false);
  });
});

describe('LAN-only link previews', () => {
  it('classifies private and public addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.9',
      '169.254.1.1',
      'fd12::1',
      'fe80::1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of [
      '8.8.8.8',
      '172.32.0.1',
      '1.1.1.1',
      '127.0.0.1',
      '2001:4860::8888',
      'not-an-ip',
    ]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  it('never fetches an internet address', async () => {
    const started = performance.now();
    expect(await fetchLanPreview('http://8.8.8.8/')).toBeNull();
    expect(await fetchLanPreview('ftp://10.0.0.1/')).toBeNull();
    expect(performance.now() - started).toBeLessThan(100); // refused before any connection
  });

  it('parses titles and descriptions', () => {
    const html =
      '<html><head><title>Canteen &amp; menu</title><meta name="description" content="This week&#39;s food"></head>';
    expect(parsePreview('http://intranet/', html)).toEqual({
      url: 'http://intranet/',
      title: 'Canteen & menu',
      description: "This week's food",
    });
    expect(parsePreview('http://x/', '<p>no title</p>')).toBeNull();
  });

  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address))?.address;

  it.skipIf(!lanIp)('previews a page served on this PC’s LAN address', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><meta property="og:title" content="Leave policy"><meta property="og:description" content="Updated October"></head><body>x</body></html>',
      );
    });
    await new Promise<void>((r) => server.listen(0, lanIp, r));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await fetchLanPreview(`http://${lanIp}:${port}/policy`)).toEqual({
        url: `http://${lanIp}:${port}/policy`,
        title: 'Leave policy',
        description: 'Updated October',
      });
    } finally {
      server.close();
    }
  });
});

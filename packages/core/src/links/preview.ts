import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LinkPreview } from '@officemesh/protocol';

const TIMEOUT_MS = 2_500;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

/** RFC 1918, link-local, and IPv6 unique-local / link-local: addresses on the office LAN. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  return false;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function meta(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? decodeEntities(content).trim() : undefined;
}

/** Extract a title and description from the start of an HTML page. */
export function parsePreview(url: string, html: string): LinkPreview | null {
  const title =
    meta(html, 'og:title') ??
    (() => {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
      return m ? decodeEntities(m.replace(/\s+/g, ' ')).trim() : undefined;
    })();
  if (!title) return null;
  const description = meta(html, 'og:description') ?? meta(html, 'description');
  return {
    url,
    title: title.slice(0, 300),
    ...(description && { description: description.slice(0, 500) }),
  };
}

/**
 * Preview a page on the office network. The host must resolve only to private addresses
 * and the request goes to the address that was checked (no DNS rebinding). Anything
 * else, including any internet address, returns null without a request being made.
 */
export async function fetchLanPreview(raw: string, redirects = 0): Promise<LinkPreview | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let address: string;
  try {
    const all = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true, verbatim: true });
    if (all.length === 0 || !all.every((a) => isPrivateAddress(a.address))) return null;
    address = all[0]!.address;
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        host: address,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, accept: 'text/html', 'user-agent': 'InterCom link preview' },
        servername: isIP(host) ? undefined : host,
        // Intranet sites commonly use internal certificates; only a title is read.
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
          res.resume();
          resolve(fetchLanPreview(new URL(res.headers.location, url).toString(), redirects + 1));
          return;
        }
        if (status !== 200 || !/text\/html/i.test(String(res.headers['content-type'] ?? ''))) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_BYTES || /<\/head>/i.test(body)) res.destroy();
        });
        res.on('close', () => resolve(parsePreview(url.toString(), body)));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

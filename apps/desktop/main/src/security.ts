import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { app, protocol, session, shell, type WebContents } from 'electron';

export const APP_SCHEME = 'officemesh';
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/** No remote origins anywhere. Fluent's CSS-in-JS injects <style> tags, hence 'unsafe-inline' for styles only. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  // 'wasm-unsafe-eval' lets the bundled MediaPipe WebAssembly compile (background blur);
  // it does not allow eval of strings.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob: mediastream:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
};

/** Must run before `app.ready`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      // stream: <video> can play files served by the app (meeting recordings).
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        codeCache: true,
        stream: true,
      },
    },
  ]);
}

const AVATAR_EXT: Array<[string, string]> = [
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['webp', 'image/webp'],
];

/**
 * Files the page may read: `/files/<sha256>?type=<the file's own type>` (completed files: inline
 * pictures, meeting recordings, and the bytes the built-in viewer shows) and
 * `/avatars/<sha256>`. Names are hashes, so no peer-supplied text reaches a path. The core only
 * answers for a complete file of exactly that type; a type that is not plain audio, video or
 * a picture is sent as opaque bytes, and every answer carries a policy that lets nothing run.
 */
const MEDIA_TYPE =
  /^(image\/(png|jpeg|gif|webp|bmp|svg\+xml)|video\/(mp4|webm)|audio\/(mpeg|wav|x-wav|ogg|webm|mp4|aac|flac|x-m4a))$/;
const ANY_TYPE = /^[\w.+-]{1,60}\/[\w.+-]{1,120}$/;

async function serveStored(
  filesDir: string,
  resolveFile: FileResolver,
  url: URL,
  range: string | null,
): Promise<Response | undefined> {
  const m = /^\/(files|avatars)\/([0-9a-f]{64})$/.exec(url.pathname);
  if (!m) return undefined;
  const [, kind, hash] = m as unknown as [string, string, string];
  const headers = {
    'x-content-type-options': 'nosniff',
    // A file can be deleted at any time: never let the page remember one.
    'cache-control': 'no-store',
    // Even if one of these were opened as a page, nothing in it could run or load.
    'content-security-policy': "default-src 'none'; sandbox",
  };
  try {
    if (kind === 'files') {
      const type = url.searchParams.get('type') ?? '';
      if (!ANY_TYPE.test(type)) return new Response('Forbidden', { status: 403 });
      const served = MEDIA_TYPE.test(type) ? type : 'application/octet-stream';
      // The core says where the file is (it is wherever the user keeps it), and only for a
      // complete file of exactly this type.
      const path = await resolveFile(hash, type);
      if (!path) return new Response('Not found', { status: 404 });
      const size = (await stat(path)).size;
      // Videos are fetched in byte ranges, so they can seek; nothing is read whole.
      const r = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
      if (r && (r[1] || r[2])) {
        const start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
        const end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          return new Response('Range not satisfiable', {
            status: 416,
            headers: { ...headers, 'content-range': `bytes */${size}` },
          });
        }
        return new Response(
          Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream,
          {
            status: 206,
            headers: {
              ...headers,
              'content-type': served,
              'accept-ranges': 'bytes',
              'content-range': `bytes ${start}-${end}/${size}`,
              'content-length': String(end - start + 1),
            },
          },
        );
      }
      return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
        headers: {
          ...headers,
          'content-type': served,
          'accept-ranges': 'bytes',
          'content-length': String(size),
        },
      });
    }
    for (const [ext, type] of AVATAR_EXT) {
      try {
        return new Response(await readFile(join(filesDir, 'avatars', `${hash}.${ext}`)), {
          headers: {
            ...headers,
            'cache-control': 'max-age=31536000, immutable',
            'content-type': type,
          },
        });
      } catch {
        // try the next extension
      }
    }
  } catch {
    // fall through
  }
  return new Response('Not found', { status: 404 });
}

/** Serve the renderer bundle from disk under officemesh://app/, refusing path traversal. */
export type FileResolver = (sha: string, type: string) => Promise<string | null>;

export function serveRenderer(
  rendererRoot: string,
  filesDir: string,
  resolveFile: FileResolver,
): void {
  const root = normalize(rendererRoot);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const stored = await serveStored(filesDir, resolveFile, url, request.headers.get('range'));
    if (stored) return stored;
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-security-policy': CONTENT_SECURITY_POLICY,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function openExternally(url: string): void {
  try {
    const { protocol: scheme } = new URL(url);
    if (scheme === 'https:' || scheme === 'http:' || scheme === 'mailto:')
      void shell.openExternal(url);
  } catch {
    // Ignore malformed URLs.
  }
}

const fromApp = (origin: string | undefined) =>
  origin !== undefined && (origin === APP_ORIGIN || origin.startsWith(`${APP_ORIGIN}/`));

/**
 * What the app's own pages may use: the camera and microphone and screen capture (calls), and
 * writing plain text or images to the clipboard (the Copy buttons; Chromium's "sanitized write").
 * Reading the clipboard is not here: a page cannot look at what the user copied elsewhere.
 */
const ALLOWED = new Set(['media', 'clipboard-sanitized-write']);

/**
 * Session-wide guards: deny every permission except those above for the app's own pages, block
 * every network request the renderer might make, and keep navigation inside the app.
 */
export function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED.has(permission) && fromApp(details.requestingUrl ?? wc.getURL()));
  });
  ses.setPermissionCheckHandler(
    (_wc, permission, origin) => ALLOWED.has(permission) && fromApp(origin),
  );
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );

  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${APP_ORIGIN}/`)) {
        event.preventDefault();
        openExternally(url);
      }
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: 'deny' };
    });
  });
}

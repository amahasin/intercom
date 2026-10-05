import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { app, protocol, session, shell, type WebContents } from 'electron';

export const APP_SCHEME = 'officemesh';
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/** No remote origins anywhere. Fluent's CSS-in-JS injects <style> tags, hence 'unsafe-inline' for styles only. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
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
  '.wasm': 'application/wasm',
};

/** Must run before `app.ready`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ]);
}

const AVATAR_EXT: Array<[string, string]> = [
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['webp', 'image/webp'],
];

/**
 * Files the page may show: `/files/<sha256>?type=image/...` (completed downloads, images
 * only) and `/avatars/<sha256>`. Names are hashes, so no peer-supplied text reaches a path.
 */
async function serveStored(filesDir: string, url: URL): Promise<Response | undefined> {
  const m = /^\/(files|avatars)\/([0-9a-f]{64})$/.exec(url.pathname);
  if (!m) return undefined;
  const [, kind, hash] = m as unknown as [string, string, string];
  const headers = {
    'x-content-type-options': 'nosniff',
    'cache-control': 'max-age=31536000, immutable',
  };
  try {
    if (kind === 'files') {
      const type = url.searchParams.get('type') ?? '';
      if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(type))
        return new Response('Forbidden', { status: 403 });
      return new Response(await readFile(join(filesDir, hash)), {
        headers: { ...headers, 'content-type': type },
      });
    }
    for (const [ext, type] of AVATAR_EXT) {
      try {
        return new Response(await readFile(join(filesDir, 'avatars', `${hash}.${ext}`)), {
          headers: { ...headers, 'content-type': type },
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
export function serveRenderer(rendererRoot: string, filesDir: string): void {
  const root = normalize(rendererRoot);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const stored = await serveStored(filesDir, url);
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
 * Session-wide guards: deny every permission except camera, microphone and screen capture
 * for the app's own pages (calls), block every network request the renderer might make,
 * and keep navigation inside the app.
 */
export function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permission === 'media' && fromApp(details.requestingUrl ?? wc.getURL()));
  });
  ses.setPermissionCheckHandler(
    (_wc, permission, origin) => permission === 'media' && fromApp(origin),
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

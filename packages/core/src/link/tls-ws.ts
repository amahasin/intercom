import type { KeyObject } from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { createSecureContext, type SecureContext, type TLSSocket } from 'node:tls';
import { WebSocket, WebSocketServer, type ClientOptions, type RawData } from 'ws';
import { DEFAULT_LINK_PORT, LINK_PATH, MAX_BINARY_FRAME_BYTES } from '@officemesh/protocol';
import { importPublicKeySpki, userIdFromSpki } from '../identity/crypto.ts';
import type { DialTarget, Logger, PeerChannel, Transport } from '../interfaces.ts';
import { BaseChannel } from './channel.ts';

const TLS_OPTIONS = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' } as const;
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** The key a TLS peer proved possession of, as SPKI DER, if it is a P-256 key. */
function peerSpki(socket: TLSSocket): Buffer | undefined {
  try {
    const cert = socket.getPeerX509Certificate();
    if (!cert) return undefined;
    const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
    importPublicKeySpki(spki);
    return spki;
  } catch {
    return undefined;
  }
}

class WsChannel extends BaseChannel {
  private readonly ws: WebSocket;

  constructor(ws: WebSocket, remoteUserId: string, remoteSpki: Buffer, logger: Logger) {
    super(remoteUserId, remoteSpki);
    this.ws = ws;
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      this.deliver(isBinary ? new Uint8Array(buf) : buf.toString('utf8'));
    });
    ws.on('close', (code, reason) => this.closed(reason.toString() || `closed (${code})`));
    ws.on('error', (err) =>
      logger.debug('link socket error', { peer: remoteUserId, err: err.message }),
    );
  }

  send(data: string | Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  close(reason = 'closed'): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, reason.slice(0, 120));
      // Do not wait for a dead peer's close frame.
      setTimeout(() => this.ws.terminate(), 2_000).unref();
    }
    this.closed(reason);
  }
}

export interface TlsWsTransportOptions {
  keyPem: string;
  certPem: string;
  /** Preferred port; falls back to a random free port if taken. 0 means random. */
  port?: number;
  host?: string;
  logger: Logger;
}

/**
 * Peer links: one WebSocket per peer pair inside mutual TLS 1.3. Certificates are
 * self-signed; each side accepts the other only if its key hashes to the expected userId.
 */
export class TlsWsTransport implements Transport {
  private readonly options: TlsWsTransportOptions;
  private server: https.Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly outbound = new Set<WebSocket>();
  /** Parsed once: re-reading the PEM key and certificate on every dial is costly. */
  private readonly clientContext: SecureContext;

  constructor(options: TlsWsTransportOptions) {
    this.options = options;
    this.clientContext = createSecureContext({
      key: options.keyPem,
      cert: options.certPem,
      ...TLS_OPTIONS,
    });
  }

  async listen(onInbound: (channel: PeerChannel) => void): Promise<number> {
    const { logger } = this.options;
    const server = https.createServer({
      key: this.options.keyPem,
      cert: this.options.certPem,
      requestCert: true,
      // Self-signed by design: authenticity is the key-to-userId hash checked below.
      rejectUnauthorized: false,
      ...TLS_OPTIONS,
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_BINARY_FRAME_BYTES,
      perMessageDeflate: false,
    });
    server.on('request', (_req, res) => {
      res.writeHead(404).end();
    });
    server.on('upgrade', (req, socket, head) => {
      const spki = peerSpki(req.socket as TLSSocket);
      if (!spki || req.url !== LINK_PATH) {
        socket.destroy();
        return;
      }
      const remoteUserId = userIdFromSpki(spki);
      wss.handleUpgrade(req, socket, head, (ws) =>
        onInbound(new WsChannel(ws, remoteUserId, spki, logger)),
      );
    });
    server.on('tlsClientError', (err) => logger.debug('inbound TLS error', { err: err.message }));
    this.server = server;
    this.wss = wss;

    const listenOn = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, this.options.host ?? '0.0.0.0', () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    const preferred = this.options.port ?? DEFAULT_LINK_PORT;
    try {
      return await listenOn(preferred);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferred === 0) throw err;
      logger.info('link port in use; using a random port', { preferred });
      return await listenOn(0);
    }
  }

  dial(target: DialTarget): Promise<PeerChannel> {
    const { logger } = this.options;
    return new Promise((resolve, reject) => {
      // ws hands every option to tls.connect; its types just do not list secureContext.
      const options: ClientOptions & { secureContext: SecureContext } = {
        secureContext: this.clientContext,
        rejectUnauthorized: false,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAX_BINARY_FRAME_BYTES,
        perMessageDeflate: false,
        ...TLS_OPTIONS,
      };
      const ws = new WebSocket(`wss://${target.address}:${target.port}${LINK_PATH}`, options);
      this.outbound.add(ws);
      let spki: Buffer | undefined;
      ws.on('upgrade', (res) => {
        spki = peerSpki(res.socket as TLSSocket);
        if (!spki || userIdFromSpki(spki) !== target.expectedUserId) {
          // ws checks readyState after this event, so the connection never opens.
          ws.terminate();
          reject(new Error('peer presented the wrong key'));
        }
      });
      ws.once('open', () => resolve(new WsChannel(ws, target.expectedUserId, spki!, logger)));
      ws.once('error', (err) => reject(err));
      ws.once('close', () => {
        this.outbound.delete(ws);
        reject(new Error('connection closed during handshake'));
      });
    });
  }

  async close(): Promise<void> {
    for (const ws of this.outbound) ws.terminate();
    this.outbound.clear();
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

/** A TLS transport presenting this identity's key and self-signed certificate. */
export function createTlsTransport(
  identity: { privateKey: KeyObject; certPem: string },
  options: { port?: number; host?: string; logger: Logger },
): TlsWsTransport {
  const keyPem = identity.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return new TlsWsTransport({ keyPem, certPem: identity.certPem, ...options });
}

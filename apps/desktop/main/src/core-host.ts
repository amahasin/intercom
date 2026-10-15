/**
 * Entry point of the Electron utility process that runs the core. It imports no Electron
 * modules: `process.parentPort` is the only Electron-specific surface, and it is used
 * only here, so `packages/core` stays runnable as a bare Node process.
 */
import {
  Core,
  CoreHost,
  createConsoleLogger,
  createTlsTransport,
  LogFile,
  LOOPBACK_ONLY,
  UdpDiscoveryDriver,
  type FramePort,
  type HostServices,
  type KeyProtector,
} from '@officemesh/core';
import { ScreenSource, type IpcFrame } from '@officemesh/protocol/ipc';
import type { CoreToMain, HostNetworkMessage, HostRequest, MainToCore } from './host-protocol.ts';
import { FakeAssistHost, HelperHost } from './remote-assist.ts';

interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  off(event: 'message', listener: (e: { data: unknown }) => void): void;
  start(): void;
  close(): void;
}

interface ParentPortMessage {
  data: MainToCore;
  ports: PortLike[];
}

const parent = (
  process as unknown as {
    parentPort?: PortLike & { on(e: 'message', l: (m: ParentPortMessage) => void): void };
  }
).parentPort;
if (!parent) {
  throw new Error('core-host must run inside an Electron utility process');
}

const logger = createConsoleLogger('core-host');
const send = (message: CoreToMain) => parent.postMessage(message);

/** Seals the identity key with Electron safeStorage (DPAPI) by asking the main process. */
class SafeStorageProtector implements KeyProtector {
  readonly scheme = 'safeStorage' as const;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }
  >();

  protect(plain: Uint8Array): Promise<Uint8Array> {
    return this.call('protect', plain);
  }

  unprotect(sealed: Uint8Array): Promise<Uint8Array> {
    return this.call('unprotect', sealed);
  }

  settle(id: number, ok: boolean, data: string | undefined, error: string | undefined): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    if (ok && data !== undefined) call.resolve(new Uint8Array(Buffer.from(data, 'base64')));
    else call.reject(new Error(error ?? 'key protection failed'));
  }

  private call(op: 'protect' | 'unprotect', bytes: Uint8Array): Promise<Uint8Array> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send({ kind: 'key-protect-req', id, op, data: Buffer.from(bytes).toString('base64') });
    });
  }
}

const protector = new SafeStorageProtector();
let host: CoreHost | undefined;
let core: Core | undefined;

/** Things only main can do (elevated firewall fix, opening Windows Settings). */
const pendingHost = new Map<
  number,
  { resolve: (data: unknown) => void; reject: (e: Error) => void }
>();
let nextHostId = 1;
function hostCall(op: HostRequest['op'], path?: string | null): Promise<unknown> {
  const id = nextHostId++;
  return new Promise((resolve, reject) => {
    pendingHost.set(id, { resolve, reject });
    send({ kind: 'host-req', id, op, ...(path !== undefined && { path }) });
  });
}
const hostServices: HostServices = {
  fixFirewall: () => hostCall('fix-firewall').then(() => {}),
  openNetworkSettings: () => void hostCall('open-network-settings').catch(() => {}),
  screenSources: async () => {
    const parsed = ScreenSource.array().safeParse(await hostCall('screen-sources'));
    return parsed.success ? parsed.data : [];
  },
  screenBorder: (sourceId) => send({ kind: 'screen-border', sourceId }),
  notify: (toast) => send({ kind: 'notify', toast }),
  calls: (calls) => send({ kind: 'calls', calls }),
  setBadge: (count) => send({ kind: 'badge', count }),
  openPath: (path) => send({ kind: 'open-path', path }),
  showInFolder: (path) => send({ kind: 'show-in-folder', path }),
  snip: () => send({ kind: 'snip' }),
  setStartWithWindows: (enabled) => send({ kind: 'start-with-windows', enabled }),
  setTheme: (theme) => send({ kind: 'theme', theme }),
  verifySignature: async (path) =>
    (await hostCall('verify-signature', path)) as {
      status: 'valid' | 'unsigned' | 'invalid';
      publisher?: string;
    },
  pickProfileFile: async () => ((await hostCall('pick-profile')) as string | null) ?? null,
  pickFolder: async (current) =>
    ((await hostCall('pick-folder', current)) as string | null) ?? null,
  runInstaller: (path) => send({ kind: 'run-installer', path }),
  relaunch: () => send({ kind: 'relaunch' }),
};

// State reported by main before the core is up is applied once it is.
let lastHostNetwork: HostNetworkMessage | undefined;
const systemState: { idle?: boolean; locked?: boolean } = {};

function adaptPort(port: PortLike): FramePort {
  return {
    post: (frame: IpcFrame) => port.postMessage(frame),
    onMessage: (listener) => {
      const handler = (e: { data: unknown }) => listener(e.data);
      port.on('message', handler);
      port.start();
      return () => port.off('message', handler);
    },
  };
}

parent.on('message', (message: ParentPortMessage) => {
  const data = message.data;
  switch (data.kind) {
    case 'init': {
      if (host) return;
      // Remote help (M6.18): the sharing helper program, or a stand-in in tests.
      hostServices.remoteAssist = data.fakeRemoteAssist
        ? new FakeAssistHost()
        : new HelperHost(
            () => data.assistHelper,
            (message, detail) => logger.warn(message, { detail: String(detail ?? '') }),
          );
      host = new CoreHost(
        () =>
          (async () => {
            const logFile = new LogFile(`${data.dataDir}/logs`);
            const coreLogger = logFile.logger(`core:${data.profile}`);
            const discovery = await UdpDiscoveryDriver.open({
              ...(data.network.discoveryPort !== undefined && { port: data.network.discoveryPort }),
              logger: coreLogger,
              ...(data.network.loopbackOnly && { interfaces: LOOPBACK_ONLY }),
            });
            try {
              return await Core.start({
                dataDir: data.dataDir,
                profile: data.profile,
                appVersion: data.appVersion,
                ...(data.updateFolder && { updateFolder: data.updateFolder }),
                ...(data.updateRepo && { updateRepo: data.updateRepo }),
                ...(data.repository && { repository: data.repository }),
                keyProtector: protector,
                logger: coreLogger,
                logFile,
                host: hostServices,
                ...(data.downloadsDir && { downloadsDir: data.downloadsDir }),
                relay: {
                  workerBin: data.relay.workerBin,
                  ...(data.relay.score !== undefined && { score: data.relay.score }),
                  ...(data.relay.meshLimit !== undefined && { meshLimit: data.relay.meshLimit }),
                  ...(data.network.loopbackOnly && { listenIps: ['127.0.0.1'] }),
                },
                network: {
                  discovery,
                  transport: (identity) =>
                    createTlsTransport(identity, {
                      ...(data.network.linkPort !== undefined && { port: data.network.linkPort }),
                      ...(data.network.loopbackOnly && { host: '127.0.0.1' }),
                      logger: coreLogger,
                    }),
                },
              });
            } catch (err) {
              await discovery.close();
              throw err;
            }
          })(),
        logger,
      );
      void host.whenReady().then((started) => {
        core = started;
        if (started) {
          if (lastHostNetwork) started.setHostNetworkStatus(lastHostNetwork);
          started.setSystemState(systemState);
        }
        const status = host!.getStatus();
        send(
          started
            ? { kind: 'status', state: 'ready' }
            : { kind: 'status', state: 'error', message: status.message ?? 'unknown' },
        );
      });
      return;
    }
    case 'file-path-req':
      send({
        kind: 'file-path-res',
        id: data.id,
        path: core?.servePath(data.sha, data.type) ?? null,
      });
      return;
    case 'system':
      if (data.idle !== undefined) systemState.idle = data.idle;
      if (data.locked !== undefined) systemState.locked = data.locked;
      core?.setSystemState(data);
      return;
    case 'power':
      core?.setPower(data.event);
      return;
    case 'host-network':
      lastHostNetwork = data;
      core?.setHostNetworkStatus(data);
      return;
    case 'call-window-closed':
      try {
        core?.hangupCall(data.callId);
      } catch {
        // already over
      }
      return;
    case 'toast-action':
      if (!core) return;
      if (data.reply?.trim()) {
        try {
          core.replyFromToast(data.convId, data.reply);
        } catch (err) {
          logger.warn('toast reply failed', { err: String(err) });
        }
      } else {
        core.openFromToast(data.convId, data.target);
      }
      return;
    case 'host-res': {
      const call = pendingHost.get(data.id);
      pendingHost.delete(data.id);
      if (data.ok) call?.resolve(data.data);
      else call?.reject(new Error(data.error ?? 'failed'));
      return;
    }
    case 'attach': {
      const port = message.ports[0];
      if (!port || !host) return;
      const detach = host.attach(adaptPort(port));
      port.on('close', detach);
      return;
    }
    case 'key-protect-res':
      protector.settle(data.id, data.ok, data.data, data.error);
      return;
    case 'shutdown':
      void (async () => {
        await host?.close();
        send({ kind: 'status', state: 'stopped' });
        process.exit(0);
      })();
      return;
  }
});

import {
  IpcRequestFrame,
  type CoreStatus,
  type IpcFrame,
  type IpcResponseFrame,
} from '@officemesh/protocol/ipc';
import type { Core } from '../core.ts';
import type { Logger } from '../interfaces.ts';
import { CommandError, dispatchCommand } from './dispatch.ts';

/** One end of a frame channel to a UI: an Electron MessagePortMain, a worker port, a test pipe. */
export interface FramePort {
  post(frame: IpcFrame): void;
  onMessage(listener: (data: unknown) => void): () => void;
}

/**
 * Serves the IPC API to any number of attached UI ports. Ports may attach before the core
 * has finished starting; their requests wait for start-up instead of failing.
 */
export class CoreHost {
  private core: Core | undefined;
  private status: CoreStatus = { state: 'starting' };
  private readonly ready: Promise<Core | undefined>;
  private readonly ports = new Map<FramePort, () => void>();
  private readonly logger: Logger;

  constructor(start: () => Promise<Core>, logger: Logger) {
    this.logger = logger;
    this.ready = start().then(
      (core) => {
        this.core = core;
        core.onEvent((name, payload) => this.broadcast({ kind: 'evt', name, payload }));
        this.setStatus({ state: 'ready' });
        return core;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('core failed to start', { message });
        this.setStatus({ state: 'error', message });
        return undefined;
      },
    );
  }

  /** Resolves once start-up has finished, with the core or undefined on failure. */
  whenReady(): Promise<Core | undefined> {
    return this.ready;
  }

  getStatus(): CoreStatus {
    return this.status;
  }

  attach(port: FramePort): () => void {
    const off = port.onMessage((data) => void this.handle(port, data));
    this.ports.set(port, off);
    port.post({ kind: 'evt', name: 'core.status', payload: this.status });
    return () => this.detach(port);
  }

  detach(port: FramePort): void {
    this.ports.get(port)?.();
    this.ports.delete(port);
  }

  async close(): Promise<void> {
    for (const port of [...this.ports.keys()]) this.detach(port);
    const core = await this.ready;
    await core?.close();
  }

  private async handle(port: FramePort, data: unknown): Promise<void> {
    const parsed = IpcRequestFrame.safeParse(data);
    if (!parsed.success) {
      this.logger.warn('dropped malformed IPC frame');
      return;
    }
    const { id, name, args } = parsed.data;
    let response: IpcResponseFrame;
    try {
      const core = await this.ready;
      if (!core) throw new CommandError('not_ready', this.status.message ?? 'core is not running');
      response = { kind: 'res', id, ok: true, result: await dispatchCommand(core, name, args) };
    } catch (err) {
      const code = err instanceof CommandError ? err.code : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'internal') this.logger.error('command failed', { name, message });
      response = { kind: 'res', id, ok: false, error: { code, message } };
    }
    if (this.ports.has(port)) port.post(response);
  }

  private setStatus(status: CoreStatus): void {
    this.status = status;
    this.broadcast({ kind: 'evt', name: 'core.status', payload: status });
  }

  private broadcast(frame: IpcFrame): void {
    for (const port of this.ports.keys()) {
      try {
        port.post(frame);
      } catch (err) {
        this.logger.warn('failed to post to UI port', { err: String(err) });
      }
    }
  }
}

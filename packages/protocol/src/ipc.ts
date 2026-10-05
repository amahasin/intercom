/**
 * The one typed API between the renderer and the core: commands in, events out.
 * The renderer never talks to the core any other way (plan section 4, rule 1).
 *
 * Frames travel over a MessagePort that the main process hands to both ends. The core
 * validates every command's input; the client validates every result and event.
 */
import { z } from 'zod';
import { EpochMs, ProfileName, PublicKeyB64, UserId } from './common.ts';
import { ProfileEdit } from './profile.ts';

// ---------------------------------------------------------------------------
// Views returned to the UI
// ---------------------------------------------------------------------------

export const IdentityView = z.object({
  userId: UserId,
  publicKey: PublicKeyB64,
  displayName: z.string(),
  jobTitle: z.string().optional(),
  statusMessage: z.string().optional(),
  profileVersion: z.number().int(),
  safetyPhrase: z.array(z.string()).length(6),
  createdAt: EpochMs,
});
export type IdentityView = z.infer<typeof IdentityView>;

export const AppInfo = z.object({
  appVersion: z.string(),
  protocolVersion: z.number().int(),
  profile: ProfileName,
  dataDir: z.string(),
  keyProtection: z.enum(['safeStorage', 'insecure-test']),
});
export type AppInfo = z.infer<typeof AppInfo>;

export const CoreStatus = z.object({
  state: z.enum(['starting', 'ready', 'error']),
  message: z.string().optional(),
});
export type CoreStatus = z.infer<typeof CoreStatus>;

// ---------------------------------------------------------------------------
// Commands and events
// ---------------------------------------------------------------------------

const NoArgs = z.object({}).strict();

export const ipcCommands = {
  'app.info': { input: NoArgs, output: AppInfo },
  'identity.get': { input: NoArgs, output: IdentityView },
  'profile.update': { input: ProfileEdit, output: IdentityView },
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export const ipcEvents = {
  'core.status': CoreStatus,
  'identity.changed': IdentityView,
} as const satisfies Record<string, z.ZodType>;

export type IpcCommandName = keyof typeof ipcCommands;
export type IpcEventName = keyof typeof ipcEvents;
export type IpcInput<N extends IpcCommandName> = z.input<(typeof ipcCommands)[N]['input']>;
export type IpcOutput<N extends IpcCommandName> = z.output<(typeof ipcCommands)[N]['output']>;
export type IpcEventPayload<N extends IpcEventName> = z.output<(typeof ipcEvents)[N]>;

export function isIpcCommandName(name: string): name is IpcCommandName {
  return Object.hasOwn(ipcCommands, name);
}

export function isIpcEventName(name: string): name is IpcEventName {
  return Object.hasOwn(ipcEvents, name);
}

// ---------------------------------------------------------------------------
// Frames on the port
// ---------------------------------------------------------------------------

export const IpcErrorCode = z.enum(['bad_request', 'unknown_command', 'not_ready', 'internal']);
export type IpcErrorCode = z.infer<typeof IpcErrorCode>;

export const IpcError = z.object({ code: IpcErrorCode, message: z.string() });
export type IpcError = z.infer<typeof IpcError>;

export const IpcRequestFrame = z.object({
  kind: z.literal('req'),
  id: z.number().int().nonnegative(),
  name: z.string().max(64),
  args: z.unknown(),
});
export type IpcRequestFrame = z.infer<typeof IpcRequestFrame>;

export const IpcResponseFrame = z.object({
  kind: z.literal('res'),
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: IpcError.optional(),
});
export type IpcResponseFrame = z.infer<typeof IpcResponseFrame>;

export const IpcEventFrame = z.object({
  kind: z.literal('evt'),
  name: z.string().max(64),
  payload: z.unknown(),
});
export type IpcEventFrame = z.infer<typeof IpcEventFrame>;

export const IpcFrame = z.discriminatedUnion('kind', [
  IpcRequestFrame,
  IpcResponseFrame,
  IpcEventFrame,
]);
export type IpcFrame = z.infer<typeof IpcFrame>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Anything that can carry frames: the preload bridge, a MessagePort, or a test pipe. */
export interface IpcTransport {
  send(frame: IpcFrame): void;
  onFrame(listener: (frame: unknown) => void): () => void;
}

export class IpcCallError extends Error {
  readonly code: IpcErrorCode;
  constructor(error: IpcError) {
    super(error.message);
    this.name = 'IpcCallError';
    this.code = error.code;
  }
}

export interface IpcClient {
  invoke<N extends IpcCommandName>(name: N, args: IpcInput<N>): Promise<IpcOutput<N>>;
  on<N extends IpcEventName>(name: N, listener: (payload: IpcEventPayload<N>) => void): () => void;
  dispose(): void;
}

export function createIpcClient(transport: IpcTransport): IpcClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { name: IpcCommandName; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const listeners = new Map<IpcEventName, Set<(payload: never) => void>>();

  const unsubscribe = transport.onFrame((raw) => {
    const parsed = IpcFrame.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === 'res') {
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      if (!frame.ok) {
        call.reject(
          new IpcCallError(frame.error ?? { code: 'internal', message: 'unknown error' }),
        );
        return;
      }
      const result = ipcCommands[call.name].output.safeParse(frame.result);
      if (result.success) call.resolve(result.data);
      else
        call.reject(
          new IpcCallError({ code: 'internal', message: `invalid result for ${call.name}` }),
        );
    } else if (frame.kind === 'evt') {
      if (!isIpcEventName(frame.name)) return;
      const payload = ipcEvents[frame.name].safeParse(frame.payload);
      if (!payload.success) return;
      for (const listener of listeners.get(frame.name) ?? []) listener(payload.data as never);
    }
  });

  return {
    invoke(name, args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { name, resolve: resolve as (v: unknown) => void, reject });
        transport.send({ kind: 'req', id, name, args });
      });
    },
    on(name, listener) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(listener as (payload: never) => void);
      return () => set.delete(listener as (payload: never) => void);
    },
    dispose() {
      unsubscribe();
      for (const call of pending.values()) {
        call.reject(new IpcCallError({ code: 'not_ready', message: 'client disposed' }));
      }
      pending.clear();
      listeners.clear();
    },
  };
}

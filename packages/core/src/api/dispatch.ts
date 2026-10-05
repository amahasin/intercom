import type { z } from 'zod';
import {
  ipcCommands,
  isIpcCommandName,
  type IpcCommandName,
  type IpcErrorCode,
  type IpcOutput,
} from '@officemesh/protocol/ipc';
import { NotAvailableError, type Core } from '../core.ts';

export class CommandError extends Error {
  readonly code: IpcErrorCode;
  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

type Handlers = {
  [N in IpcCommandName]: (
    core: Core,
    input: z.output<(typeof ipcCommands)[N]['input']>,
  ) => IpcOutput<N> | Promise<IpcOutput<N>>;
};

/** The command surface exposed over IPC. Every handler receives schema-validated input. */
const handlers: Handlers = {
  'app.info': (core) => core.appInfo(),
  'identity.get': (core) => core.identityView(),
  'profile.update': (core, edit) => core.updateProfile(edit),
  'presence.get': (core) => core.presenceView(),
  'presence.set': (core, { state }) => core.setPresence(state),
  'people.list': (core) => core.people(),
  'people.setTrust': (core, { userId, ...change }) => core.setPeerTrust(userId, change),
  'conversations.list': (core) => core.conversationList(),
  'conversations.openDirect': (core, { userId }) => core.openDirect(userId),
  'messages.list': (core, { convId, limit, before }) => core.listMessages(convId, limit, before),
  'messages.send': (core, { convId, text }) => core.sendMessage(convId, text),
  'network.status': (core) => core.networkStatus(),
  'network.fixFirewall': (core) => core.fixFirewall(),
  'network.openSettings': (core) => {
    core.openNetworkSettings();
    return {};
  },
};

export async function dispatchCommand(core: Core, name: string, args: unknown): Promise<unknown> {
  if (!isIpcCommandName(name))
    throw new CommandError('unknown_command', `unknown command: ${name}`);
  const parsed = ipcCommands[name].input.safeParse(args ?? {});
  if (!parsed.success) {
    throw new CommandError(
      'bad_request',
      `invalid arguments for ${name}: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  const handler = handlers[name] as (core: Core, input: unknown) => unknown;
  try {
    return await handler(core, parsed.data);
  } catch (err) {
    if (err instanceof NotAvailableError) throw new CommandError('bad_request', err.message);
    if (err instanceof Error && /empty|unknown conversation|yourself/.test(err.message)) {
      throw new CommandError('bad_request', err.message);
    }
    throw err;
  }
}

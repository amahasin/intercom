/**
 * Remote help (M6.18) on this PC: sharing the desktop with a colleague, or showing theirs.
 *
 * Windows has a programming interface for this, the Remote Desktop Services session sharing API
 * (the one Windows Remote Assistance itself is built on). It lets a program make the invitation
 * and its password in code, so nobody types or sees one; pick which screen is shared; and draw
 * the viewer window the way this app wants it. A small compiled helper (resources/assist.cs,
 * built into intercom-assist.exe) uses it, one process per session, and talks to this class with
 * one JSON object per line: commands in, events out. Closing this app (or the core process)
 * closes the helper's input, which ends the session.
 */
import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { AssistExit, RemoteAssistHost } from '@officemesh/core';
import { ASSIST_MAX_SCREENS, AssistTicketBody, type AssistScreen } from '@officemesh/protocol';
import type { AssistStatus } from '@officemesh/protocol/ipc';

const SYSTEM32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
/** How long the helper may take to start a sharing session. */
const READY_MS = 30_000;
/** How long it gets to close its windows after "end" before it is stopped. */
const STOP_GRACE_MS = 2_000;

/** What the helper says it ended for, as a reason for the manager. */
function exitFor(reason: string): AssistExit {
  switch (reason) {
    case 'ended':
    case 'closed':
      return 'closed';
    case 'left':
    case 'peer-ended':
      return 'peer-left';
    case 'no-viewer':
    case 'connect-failed':
      return 'no-connection';
    default:
      return 'failed';
  }
}

/** A DWORD from the registry, or undefined when it is not set. */
function dword(key: string, value: string): Promise<number | undefined> {
  return new Promise((resolve) =>
    execFile(
      join(SYSTEM32, 'reg.exe'),
      ['query', key, '/v', value],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        const m = err ? null : /REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
        resolve(m ? parseInt(m[1]!, 16) : undefined);
      },
    ),
  );
}

type HelperEvent = { event: string; [key: string]: unknown };
type Child = ChildProcessByStdio<Writable, Readable, null>;

interface Running {
  child: Child;
  sessionId: string;
  /** This host ended it (stop): its exit is not news. */
  stopping: boolean;
  /** Why the helper said it was closing, if it did. */
  closedFor: string | undefined;
  /** Waiting for a particular event (the sharer's "ready"). */
  waiter: ((e: HelperEvent) => boolean) | undefined;
}

export class HelperHost implements RemoteAssistHost {
  private readonly running = new Map<string, Running>();
  private exit: ((sessionId: string, reason: AssistExit) => void) | undefined;
  private screen: ((sessionId: string, index: number) => void) | undefined;
  private chat: ((sessionId: string) => void) | undefined;
  private control: ((sessionId: string, on: boolean) => void) | undefined;

  private readonly helperPath: () => string | undefined;
  private readonly log: (message: string, detail?: unknown) => void;

  constructor(
    helperPath: () => string | undefined,
    log: (message: string, detail?: unknown) => void = () => {},
  ) {
    this.helperPath = helperPath;
    this.log = log;
  }

  async status(): Promise<AssistStatus> {
    const path = this.helperPath();
    // Both the helper and Windows' sharing components must be there.
    const available =
      path !== undefined && existsSync(path) && existsSync(join(SYSTEM32, 'rdpsharercom.dll'));
    // Informational: the setting "Allow Remote Assistance connections to this computer" (a policy,
    // when set, wins). The sharing API is not known to need it, so nothing is refused for it.
    const policy = await dword(
      'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services',
      'fAllowToGetHelp',
    );
    const local = await dword(
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Remote Assistance',
      'fAllowToGetHelp',
    );
    return { available, allowed: available && (policy ?? local) === 1 };
  }

  async share(
    sessionId: string,
    peerName: string,
  ): Promise<{ ticket: string; password: string; screens: AssistScreen[] }> {
    // Tests on one PC set this so the colleague (the same PC) can only look: it can only reduce
    // what the colleague may do, never add to it.
    const viewOnly = process.env['INTERCOM_ASSIST_CONTROL'] === 'view' ? ['--control', 'view'] : [];
    const r = this.start(sessionId, ['share', '--peer', peerName, ...viewOnly]);
    const ready = await this.until(r, (e) => e.event === 'ready' || e.event === 'error');
    if (ready.event !== 'ready') {
      this.stop(sessionId);
      throw new Error(String(ready.message ?? 'Windows could not start sharing this screen.'));
    }
    // The same checks the colleague's PC will make of what is sent.
    const parsed = AssistTicketBody.omit({ sessionId: true }).safeParse(ready);
    if (!parsed.success) {
      this.stop(sessionId);
      throw new Error('The sharing helper answered with something unexpected.');
    }
    return {
      ticket: parsed.data.ticket,
      password: parsed.data.password,
      screens: parsed.data.screens ?? [],
    };
  }

  async view(
    sessionId: string,
    connect: {
      ticket: string;
      password: string;
      screens: AssistScreen[];
      peerName: string;
      selfName: string;
    },
  ): Promise<void> {
    const r = this.start(sessionId, ['view']);
    this.send(r, {
      cmd: 'connect',
      ticket: connect.ticket,
      password: connect.password,
      peer: connect.peerName,
      self: connect.selfName,
      screens: connect.screens,
    });
  }

  selectScreen(sessionId: string, index: number): void {
    const r = this.running.get(sessionId);
    if (r) this.send(r, { cmd: 'screen', index });
  }

  setControl(sessionId: string, on: boolean): void {
    const r = this.running.get(sessionId);
    if (r) this.send(r, { cmd: 'control', on });
  }

  onControl(listener: (sessionId: string, on: boolean) => void): void {
    this.control = listener;
  }

  stop(sessionId: string): void {
    const r = this.running.get(sessionId);
    if (!r) return;
    r.stopping = true;
    this.running.delete(sessionId);
    this.send(r, { cmd: 'end' });
    const kill = setTimeout(() => {
      try {
        if (r.child.exitCode === null) r.child.kill();
      } catch {
        // Already gone.
      }
    }, STOP_GRACE_MS);
    kill.unref();
    r.child.once('exit', () => clearTimeout(kill));
  }

  onExit(listener: (sessionId: string, reason: AssistExit) => void): void {
    this.exit = listener;
  }

  onScreen(listener: (sessionId: string, index: number) => void): void {
    this.screen = listener;
  }

  onChat(listener: (sessionId: string) => void): void {
    this.chat = listener;
  }

  openSettings(): void {
    execFile(join(SYSTEM32, 'SystemPropertiesRemote.exe'), [], () => {});
  }

  // ---------------------------------------------------------------------------

  private start(sessionId: string, args: string[]): Running {
    const path = this.helperPath();
    if (!path || !existsSync(path))
      throw new Error('The remote help helper is missing from this install.');
    this.stop(sessionId);
    const child = spawn(path, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: false,
    }) as Child;
    const r: Running = {
      child,
      sessionId,
      stopping: false,
      closedFor: undefined,
      waiter: undefined,
    };
    this.running.set(sessionId, r);
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(r, line));
    child.on('error', (err) => {
      this.log('remote help helper could not start', String(err));
      this.finish(r, 'failed');
    });
    child.on('exit', () => this.finish(r, exitFor(r.closedFor ?? 'error')));
    return r;
  }

  private onLine(r: Running, line: string): void {
    let e: HelperEvent;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as HelperEvent).event !== 'string'
      )
        return;
      e = parsed as HelperEvent;
    } catch {
      return;
    }
    if (r.waiter?.(e)) r.waiter = undefined;
    switch (e.event) {
      case 'closed':
        r.closedFor = String(e.reason ?? 'error');
        return;
      case 'screen': {
        const index = Number(e.index);
        if (Number.isInteger(index) && index >= -1 && index < ASSIST_MAX_SCREENS)
          this.screen?.(r.sessionId, index);
        return;
      }
      case 'chat':
        this.chat?.(r.sessionId);
        return;
      case 'control':
        if (typeof e.on === 'boolean') this.control?.(r.sessionId, e.on);
        return;
      case 'error':
        this.log('remote help helper', String(e.message ?? ''));
        return;
      default:
        return;
    }
  }

  private finish(r: Running, reason: AssistExit): void {
    if (this.running.get(r.sessionId) === r) this.running.delete(r.sessionId);
    if (r.stopping) return;
    r.stopping = true;
    this.exit?.(r.sessionId, reason);
  }

  private send(r: Running, command: Record<string, unknown>): void {
    try {
      r.child.stdin.write(`${JSON.stringify(command)}\n`);
    } catch {
      // The helper is gone; its exit says so.
    }
  }

  /** The first event the helper sends that `match` accepts. */
  private until(r: Running, match: (e: HelperEvent) => boolean): Promise<HelperEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        r.waiter = undefined;
        reject(new Error('Windows took too long to start sharing this screen.'));
      }, READY_MS);
      r.waiter = (e) => {
        if (!match(e)) return false;
        clearTimeout(timer);
        resolve(e);
        return true;
      };
      r.child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('The sharing helper closed before it was ready.'));
      });
    });
  }
}

/** For tests (--fake-remote-assist): no helper is started; the details are made up. */
export class FakeAssistHost implements RemoteAssistHost {
  private exit: ((sessionId: string, reason: AssistExit) => void) | undefined;
  private screen: ((sessionId: string, index: number) => void) | undefined;
  private chat: ((sessionId: string) => void) | undefined;
  private control: ((sessionId: string, on: boolean) => void) | undefined;
  private readonly open = new Set<string>();
  readonly log: string[] = [];

  status = async (): Promise<AssistStatus> => ({ available: true, allowed: true });
  share = async (sessionId: string) => {
    this.open.add(sessionId);
    this.log.push(`share:${sessionId}`);
    return {
      ticket: '<E><A KH="test"/></E>',
      password: 'testpassword123456',
      screens: [
        { w: 1920, h: 1080, primary: true },
        { w: 1280, h: 720, primary: false },
      ],
    };
  };
  view = async (sessionId: string): Promise<void> => {
    this.open.add(sessionId);
    this.log.push(`view:${sessionId}`);
  };
  selectScreen = (sessionId: string, index: number): void => {
    this.log.push(`screen:${sessionId}:${index}`);
  };
  setControl = (sessionId: string, on: boolean): void => {
    this.log.push(`control:${sessionId}:${on}`);
    // The sharing helper reports the change back, as the real one does.
    this.control?.(sessionId, on);
  };
  onControl = (listener: (sessionId: string, on: boolean) => void): void => {
    this.control = listener;
  };
  stop = (sessionId: string): void => {
    this.open.delete(sessionId);
  };
  onExit = (listener: (sessionId: string, reason: AssistExit) => void): void => {
    this.exit = listener;
  };
  onScreen = (listener: (sessionId: string, index: number) => void): void => {
    this.screen = listener;
  };
  onChat = (listener: (sessionId: string) => void): void => {
    this.chat = listener;
  };
  openSettings = (): void => void this.log.push('settings');
  /** The person closed the window (tests). */
  close(sessionId: string): void {
    if (this.open.delete(sessionId)) this.exit?.(sessionId, 'closed');
  }
  /** A colleague connected on the sharing side (tests): control starts on. */
  connected(sessionId: string): void {
    this.control?.(sessionId, true);
  }
  /** The viewer picked a screen (tests). */
  pick(sessionId: string, index: number): void {
    this.screen?.(sessionId, index);
  }
  /** The viewer asked for the conversation (tests). */
  openChat(sessionId: string): void {
    this.chat?.(sessionId);
  }
}

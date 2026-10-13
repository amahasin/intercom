/**
 * Remote control of a shared screen or window. While somebody the user allowed is controlling
 * what is being shared, their mouse and keyboard events (sent over the call, see the call
 * engine) are turned into real input here. Electron cannot inject input, so a small compiled
 * helper (resources/rcinput.cs, built into rcinput.exe) calls `SendInput`; it runs only while
 * control is granted.
 *
 * Guards, all enforced here and in the helper, not only in the page: input is accepted only from
 * a call window while control is on; mouse positions are fractions of the shared surface and
 * are mapped onto it only; nothing is delivered into this app's own windows (the helper asks
 * Windows which window is really under the pointer, so a covered window does not count, and
 * keys are dropped while a window of this app has the keyboard: the person sharing keeps the
 * controls to stop it); events are rate-limited; held keys and buttons are released at the end.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** `KeyboardEvent.code` to a Set 1 scan code (and whether the key is an "extended" one). */
const SCAN: Record<string, [number, boolean]> = {
  Escape: [0x01, false],
  Digit1: [0x02, false],
  Digit2: [0x03, false],
  Digit3: [0x04, false],
  Digit4: [0x05, false],
  Digit5: [0x06, false],
  Digit6: [0x07, false],
  Digit7: [0x08, false],
  Digit8: [0x09, false],
  Digit9: [0x0a, false],
  Digit0: [0x0b, false],
  Minus: [0x0c, false],
  Equal: [0x0d, false],
  Backspace: [0x0e, false],
  Tab: [0x0f, false],
  KeyQ: [0x10, false],
  KeyW: [0x11, false],
  KeyE: [0x12, false],
  KeyR: [0x13, false],
  KeyT: [0x14, false],
  KeyY: [0x15, false],
  KeyU: [0x16, false],
  KeyI: [0x17, false],
  KeyO: [0x18, false],
  KeyP: [0x19, false],
  BracketLeft: [0x1a, false],
  BracketRight: [0x1b, false],
  Enter: [0x1c, false],
  ControlLeft: [0x1d, false],
  KeyA: [0x1e, false],
  KeyS: [0x1f, false],
  KeyD: [0x20, false],
  KeyF: [0x21, false],
  KeyG: [0x22, false],
  KeyH: [0x23, false],
  KeyJ: [0x24, false],
  KeyK: [0x25, false],
  KeyL: [0x26, false],
  Semicolon: [0x27, false],
  Quote: [0x28, false],
  Backquote: [0x29, false],
  ShiftLeft: [0x2a, false],
  Backslash: [0x2b, false],
  KeyZ: [0x2c, false],
  KeyX: [0x2d, false],
  KeyC: [0x2e, false],
  KeyV: [0x2f, false],
  KeyB: [0x30, false],
  KeyN: [0x31, false],
  KeyM: [0x32, false],
  Comma: [0x33, false],
  Period: [0x34, false],
  Slash: [0x35, false],
  ShiftRight: [0x36, false],
  NumpadMultiply: [0x37, false],
  AltLeft: [0x38, false],
  Space: [0x39, false],
  CapsLock: [0x3a, false],
  F1: [0x3b, false],
  F2: [0x3c, false],
  F3: [0x3d, false],
  F4: [0x3e, false],
  F5: [0x3f, false],
  F6: [0x40, false],
  F7: [0x41, false],
  F8: [0x42, false],
  F9: [0x43, false],
  F10: [0x44, false],
  NumLock: [0x45, false],
  ScrollLock: [0x46, false],
  Numpad7: [0x47, false],
  Numpad8: [0x48, false],
  Numpad9: [0x49, false],
  NumpadSubtract: [0x4a, false],
  Numpad4: [0x4b, false],
  Numpad5: [0x4c, false],
  Numpad6: [0x4d, false],
  NumpadAdd: [0x4e, false],
  Numpad1: [0x4f, false],
  Numpad2: [0x50, false],
  Numpad3: [0x51, false],
  Numpad0: [0x52, false],
  NumpadDecimal: [0x53, false],
  IntlBackslash: [0x56, false],
  F11: [0x57, false],
  F12: [0x58, false],
  NumpadEnter: [0x1c, true],
  ControlRight: [0x1d, true],
  NumpadDivide: [0x35, true],
  AltRight: [0x38, true],
  Home: [0x47, true],
  ArrowUp: [0x48, true],
  PageUp: [0x49, true],
  ArrowLeft: [0x4b, true],
  ArrowRight: [0x4d, true],
  End: [0x4f, true],
  ArrowDown: [0x50, true],
  PageDown: [0x51, true],
  Insert: [0x52, true],
  Delete: [0x53, true],
  ContextMenu: [0x5d, true],
};

/** The scan code for a key, or null for keys that are never sent (the Windows key, unknown). */
export function scanFor(code: string): [number, boolean] | null {
  return SCAN[code] ?? null;
}

/** What is being shared: a rectangle of the screen (physical pixels), or one window. */
export type RemoteTarget =
  { rect: { x: number; y: number; width: number; height: number } } | { hwnd: number };

export type RemoteEvent =
  | { type: 'cursor'; x: number; y: number; by: 'controller' | 'sharer' }
  | { type: 'failed'; reason: string };

/** Events a controller may send: positions are fractions (0..1) of the shared surface. */
export type RemoteInputEvent =
  | { k: 'move'; x: number; y: number }
  | { k: 'down' | 'up'; b: number; x: number; y: number }
  | { k: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { k: 'key'; code: string; down: boolean };

const BUTTON: Record<string, { down: number; up: number }> = {
  '0': { down: 0x0002, up: 0x0004 },
  '1': { down: 0x0020, up: 0x0040 },
  '2': { down: 0x0008, up: 0x0010 },
};
const MAX_EVENTS_PER_SECOND = 1_200;
/** The pointer counts as the controller's for this long after the last input from them. */
const CONTROLLER_MOVES_MS = 600;
const START_TIMEOUT_MS = 5_000;

const unit = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN);
const fixed = (n: number) => n.toFixed(5);

export class RemoteInput {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private active = false;
  private budget = MAX_EVENTS_PER_SECOND;
  private refilled = Date.now();
  private lastInput = 0;
  private readonly pressed = new Set<string>();
  private readonly helperPath: () => string | undefined;
  private readonly emit: (e: RemoteEvent) => void;

  constructor(helperPath: () => string | undefined, emit: (e: RemoteEvent) => void) {
    this.helperPath = helperPath;
    this.emit = emit;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Control was granted (or ended). Resolves with whether input can now be delivered, and why not. */
  async setActive(
    active: boolean,
    target: RemoteTarget | undefined,
    ourPid: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!active) {
      this.stop();
      return { ok: true };
    }
    if (!target) return { ok: false, reason: 'nothing is being shared' };
    this.stop();
    const path = this.helperPath();
    if (!path)
      return {
        ok: false,
        reason: 'the remote control helper (rcinput.exe) is missing from this install',
      };
    const started = await this.start(path);
    if (!started.ok) return started;
    this.send(`P ${ourPid}`);
    if ('hwnd' in target) this.send(`T ${target.hwnd}`);
    else {
      const r = target.rect;
      this.send(
        `R ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)}`,
      );
    }
    this.send('C 1');
    this.active = true;
    return { ok: true };
  }

  private start(path: string): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { ok: boolean; reason?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        this.stop();
        done({ ok: false, reason: 'the remote control helper did not start' });
      }, START_TIMEOUT_MS);
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(path, [], { windowsHide: true });
      } catch (err) {
        done({
          ok: false,
          reason: `the remote control helper could not be started (${String(err)})`,
        });
        return;
      }
      this.proc = proc;
      proc.stderr.on('data', () => {});
      proc.on('error', (err) => {
        done({
          ok: false,
          reason: `the remote control helper could not be started (${err.message})`,
        });
        this.stop();
      });
      proc.on('exit', () => {
        const wasActive = this.active;
        if (this.proc === proc) {
          this.proc = undefined;
          this.active = false;
        }
        done({ ok: false, reason: 'the remote control helper stopped at once' });
        if (wasActive) this.emit({ type: 'failed', reason: 'the remote control helper stopped' });
      });
      createInterface({ input: proc.stdout }).on('line', (line) => {
        if (line === 'ready') done({ ok: true });
        else if (line === 'gone')
          this.emit({ type: 'failed', reason: 'the shared window was closed' });
        else if (line.startsWith('C ')) {
          const [x, y] = line.slice(2).split(' ').map(Number);
          if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y))
            this.emit({
              type: 'cursor',
              x,
              y,
              by: Date.now() - this.lastInput < CONTROLLER_MOVES_MS ? 'controller' : 'sharer',
            });
        }
      });
    });
  }

  stop(): void {
    this.active = false;
    // Never leave a key held down on this PC.
    for (const code of this.pressed) this.key(code, false);
    this.pressed.clear();
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    try {
      proc.stdin.write('C 0\nQ\n');
      proc.stdin.end();
    } catch {
      // already gone
    }
    setTimeout(() => proc.kill(), 1_500).unref();
  }

  private send(line: string): void {
    if (this.proc && !this.proc.stdin.destroyed) this.proc.stdin.write(`${line}\n`);
  }

  private key(code: string, down: boolean): void {
    const scan = scanFor(code);
    if (scan) this.send(`K ${scan[0]} ${down ? 0 : 1} ${scan[1] ? 1 : 0}`);
  }

  /** Deliver one event from the controller. Anything unexpected is dropped. */
  handle(raw: unknown): void {
    if (!this.active || typeof raw !== 'object' || raw === null) return;
    const now = Date.now();
    this.budget = Math.min(
      MAX_EVENTS_PER_SECOND,
      this.budget + ((now - this.refilled) / 1_000) * MAX_EVENTS_PER_SECOND,
    );
    this.refilled = now;
    if (this.budget < 1) return;
    this.budget -= 1;
    const e = raw as Partial<RemoteInputEvent> & { k?: unknown };
    this.lastInput = now;
    switch (e.k) {
      case 'move': {
        const x = unit(Number(e.x));
        const y = unit(Number(e.y));
        if (!Number.isNaN(x) && !Number.isNaN(y)) this.send(`M ${fixed(x)} ${fixed(y)}`);
        return;
      }
      case 'down':
      case 'up': {
        const button = BUTTON[String((e as { b?: unknown }).b)];
        const x = unit(Number(e.x));
        const y = unit(Number(e.y));
        if (!button || Number.isNaN(x) || Number.isNaN(y)) return;
        this.send(`M ${fixed(x)} ${fixed(y)}`);
        this.send(`B ${e.k === 'down' ? button.down : button.up}`);
        return;
      }
      case 'wheel': {
        const clamp = (n: unknown) => Math.max(-1200, Math.min(1200, Math.round(Number(n))));
        const dy = clamp((e as { dy?: unknown }).dy);
        const dx = clamp((e as { dx?: unknown }).dx);
        const x = unit(Number(e.x));
        const y = unit(Number(e.y));
        if (Number.isNaN(x) || Number.isNaN(y)) return;
        this.send(`M ${fixed(x)} ${fixed(y)}`);
        // Browser wheel deltas point the other way round from Windows'.
        if (Number.isFinite(dy) && dy !== 0) this.send(`W 2048 ${-dy}`);
        if (Number.isFinite(dx) && dx !== 0) this.send(`W 4096 ${dx}`);
        return;
      }
      case 'key': {
        const code = (e as { code?: unknown }).code;
        const down = (e as { down?: unknown }).down === true;
        if (typeof code !== 'string' || !scanFor(code)) return;
        if (down) this.pressed.add(code);
        else this.pressed.delete(code);
        this.key(code, down);
        return;
      }
    }
  }
}

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Clock, Logger, TimerHandle } from './interfaces.ts';

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (h) => clearTimeout(h as unknown as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as TimerHandle,
  clearInterval: (h) => clearInterval(h as unknown as NodeJS.Timeout),
};

export function createConsoleLogger(scope: string): Logger {
  const line = (level: string, message: string, data?: Record<string, unknown>) =>
    `${new Date().toISOString()} ${level} [${scope}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`;
  return {
    debug: (m, d) => {
      if (process.env['OFFICEMESH_DEBUG']) console.debug(line('DEBUG', m, d));
    },
    info: (m, d) => console.info(line('INFO', m, d)),
    warn: (m, d) => console.warn(line('WARN', m, d)),
    error: (m, d) => console.error(line('ERROR', m, d)),
  };
}

/**
 * A log file per profile, for the diagnostics export (M6): `officemesh.log`, rotated at
 * 2 MB with two older generations kept. Also writes to the console. Never logs message
 * content: callers log ids, counts and errors only.
 */
export class LogFile {
  static readonly MAX_BYTES = 2 * 1024 * 1024;
  readonly path: string;
  private size: number;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'officemesh.log');
    this.size = existsSync(this.path) ? statSync(this.path).size : 0;
  }

  logger(scope: string): Logger {
    const console = createConsoleLogger(scope);
    const write = (level: string, m: string, d?: Record<string, unknown>) => {
      const line = `${new Date().toISOString()} ${level} [${scope}] ${m}${d ? ' ' + JSON.stringify(d) : ''}\n`;
      try {
        if (this.size + line.length > LogFile.MAX_BYTES) this.rotate();
        appendFileSync(this.path, line);
        this.size += Buffer.byteLength(line);
      } catch {
        // A full or locked disk must not stop the app.
      }
    };
    return {
      debug: (m, d) => {
        console.debug(m, d);
        if (process.env['OFFICEMESH_DEBUG']) write('DEBUG', m, d);
      },
      info: (m, d) => (console.info(m, d), write('INFO', m, d)),
      warn: (m, d) => (console.warn(m, d), write('WARN', m, d)),
      error: (m, d) => (console.error(m, d), write('ERROR', m, d)),
    };
  }

  private rotate(): void {
    const old2 = `${this.path}.2`;
    const old1 = `${this.path}.1`;
    rmSync(old2, { force: true });
    if (existsSync(old1)) renameSync(old1, old2);
    if (existsSync(this.path)) renameSync(this.path, old1);
    this.size = 0;
  }

  /** The last `lines` lines across the current and previous file, oldest first. */
  tail(lines: number): string[] {
    const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n') : []);
    const all = [...read(`${this.path}.1`), ...read(this.path)].filter((l) => l.length > 0);
    return all.slice(-lines);
  }
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

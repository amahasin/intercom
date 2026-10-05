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

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

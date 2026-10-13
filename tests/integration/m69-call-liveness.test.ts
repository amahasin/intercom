import { describe, expect, it } from 'vitest';
import {
  CONNECT_RESTART_MS,
  CONNECT_TIMEOUT_MS,
  DROP_AFTER_MS,
  FAILED_DROP_MS,
  RECOVER_AFTER_MS,
  RESTART_EVERY_MS,
  judgeLink,
} from '../../apps/desktop/renderer/src/calls/liveness.ts';

const up = { connected: true, failedMs: 0, sinceRestartMs: 60_000 };

describe('M6.10 when a call connection is given up on', () => {
  it('does not drop anybody for a hiccup: a few seconds of quiet only restarts the connection', () => {
    expect(judgeLink({ ...up, quietMs: 800 })).toBe('ok');
    // What used to be fatal (6 s without a heartbeat) is now a restart, not a removal.
    expect(judgeLink({ ...up, quietMs: 6_000 })).toBe('restart');
    expect(judgeLink({ ...up, quietMs: DROP_AFTER_MS - 500 })).toBe('restart');
    // Not restarted again and again.
    expect(judgeLink({ ...up, quietMs: 6_000, sinceRestartMs: 2_000 })).toBe('ok');
    expect(RECOVER_AFTER_MS).toBeLessThan(DROP_AFTER_MS);
    expect(RESTART_EVERY_MS).toBeLessThan(DROP_AFTER_MS);
    // A PC that died is still noticed within 10 s.
    expect(DROP_AFTER_MS).toBeLessThan(10_000);
  });

  it('drops someone who has really gone: a long silence, or a connection that stays failed', () => {
    expect(judgeLink({ ...up, quietMs: DROP_AFTER_MS + 1 })).toBe('drop');
    expect(judgeLink({ ...up, quietMs: 1_000, failedMs: 5_000 })).toBe('restart');
    expect(judgeLink({ ...up, quietMs: 1_000, failedMs: FAILED_DROP_MS + 1 })).toBe('drop');
  });

  it('gives a connection that is still being made time, and a second try', () => {
    const making = { connected: false, failedMs: 0, sinceRestartMs: 60_000 };
    expect(judgeLink({ ...making, quietMs: 10_000 })).toBe('ok');
    expect(judgeLink({ ...making, quietMs: CONNECT_RESTART_MS + 1 })).toBe('restart');
    expect(judgeLink({ ...making, quietMs: CONNECT_TIMEOUT_MS + 1 })).toBe('drop');
    // Older than the old 20 s limit and not dropped.
    expect(judgeLink({ ...making, quietMs: 25_000 })).not.toBe('drop');
  });
});

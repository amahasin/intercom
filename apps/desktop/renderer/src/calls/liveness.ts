/**
 * When a call connection to a participant is given up on. Dropping one removes them from the call
 * for everyone and ends the call for them, so it must not fire on a hiccup: a busy PC, a
 * whiteboard picture that holds up the data channel, Wi-Fi changing access point. A quiet or
 * failed link first has its connection restarted, again and again, before it is dropped.
 */

/**
 * Nothing heard from a connected participant for this long (no heartbeat, no whiteboard or
 * control message, and no sound or picture coming in: `lastHeard` counts all of them): they are
 * gone (cable pulled, PC off). Anyone still there is heard on one of those within a second or two,
 * so this is not a hiccup; a call that must notice a dead PC within 10 s still does.
 */
export const DROP_AFTER_MS = 7_000;
/** A link this quiet has its connection restarted. */
export const RECOVER_AFTER_MS = 4_000;
/** Sound and picture still coming in are looked for once a link has been quiet this long. */
export const PROBE_AFTER_MS = 1_500;
export const RESTART_EVERY_MS = 4_000;
/** A connection that never comes up is given up after this long (restarted from 15 s on). */
export const CONNECT_TIMEOUT_MS = 45_000;
export const CONNECT_RESTART_MS = 15_000;
/** A link whose person is not (yet) in the roster is kept this long: the roster may be late. */
export const ORPHAN_GRACE_MS = 20_000;
/** A connection that has been `failed` this long is dropped. */
export const FAILED_DROP_MS = 15_000;

export interface LinkFacts {
  /** The connection has been up at some point. */
  connected: boolean;
  /** Since anything was heard (or, before it connected, since it was made). */
  quietMs: number;
  /** How long the connection has been in the `failed` state (0 when it is not). */
  failedMs: number;
  sinceRestartMs: number;
}

/** What to do about a link: nothing, restart its connection, or drop the person. */
export function judgeLink(f: LinkFacts): 'ok' | 'restart' | 'drop' {
  if (f.connected) {
    if (f.quietMs > DROP_AFTER_MS || f.failedMs > FAILED_DROP_MS) return 'drop';
    const trouble = f.quietMs > RECOVER_AFTER_MS || f.failedMs > 0;
    return trouble && f.sinceRestartMs > RESTART_EVERY_MS ? 'restart' : 'ok';
  }
  if (f.quietMs > CONNECT_TIMEOUT_MS) return 'drop';
  return f.quietMs > CONNECT_RESTART_MS && f.sinceRestartMs > RESTART_EVERY_MS ? 'restart' : 'ok';
}

import { useEffect, useState } from 'react';

/** How long a banner that only informs stays up. */
export const INFO_BANNER_MS = 10_000;

/**
 * An informational banner is ephemeral: it shows for a few seconds and goes, and comes back only
 * when what it says is new. `key` names what it says (a different key is a new message; `undefined`
 * is no message). Returns true once the banner has run its time. A banner that asks the person to
 * do something (Fix, Accept, Install) does not use this: it stays until they act.
 */
export function useExpired(key: string | undefined, ms = INFO_BANNER_MS): boolean {
  const [expiredKey, setExpiredKey] = useState<string>();
  useEffect(() => {
    if (key === undefined) return;
    const timer = window.setTimeout(() => setExpiredKey(key), ms);
    return () => window.clearTimeout(timer);
  }, [key, ms]);
  return key !== undefined && expiredKey === key;
}

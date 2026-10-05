import { z } from 'zod';
import { EpochMs, PublicKeyB64, SignatureB64, UserId } from './common.ts';
import { PresenceState } from './presence.ts';

export const BEACON_MULTICAST_GROUP = '239.255.77.77';
export const BEACON_PORT = 47800;
export const DEFAULT_LINK_PORT = 47801;
export const BEACON_INTERVAL_MS = 5_000;
export const PEER_OFFLINE_AFTER_MS = 15_000;
export const MAX_BEACON_CLOCK_SKEW_MS = 30_000;
export const MAX_BEACON_BYTES = 512;

/**
 * UDP discovery beacon. Carries only versions; details are fetched over a peer link.
 * `alive` is sent every 5 s and on change; `bye` on quit and before sleep.
 */
export const BeaconBody = z.object({
  v: z.number().int().min(1),
  kind: z.enum(['alive', 'bye']),
  userId: UserId,
  pub: PublicKeyB64,
  port: z.number().int().min(1).max(65535),
  presence: PresenceState,
  profileVer: z.number().int().nonnegative(),
  ts: EpochMs,
});
export type BeaconBody = z.infer<typeof BeaconBody>;

export const SignedBeacon = BeaconBody.extend({ sig: SignatureB64 });
export type SignedBeacon = z.infer<typeof SignedBeacon>;

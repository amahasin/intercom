import type { KeyObject } from 'node:crypto';
import {
  decodeBase64Url,
  encodeBase64Url,
  MAX_BEACON_BYTES,
  MAX_BEACON_CLOCK_SKEW_MS,
  PROTOCOL_VERSION,
  SignedBeacon,
  type BeaconBody,
} from '@officemesh/protocol';
import {
  importPublicKeySpki,
  signRecord,
  userIdFromSpki,
  verifyRecord,
} from '../identity/crypto.ts';

export interface BeaconSigner {
  userId: string;
  spki: Buffer;
  privateKey: KeyObject;
}

export function encodeBeacon(
  signer: BeaconSigner,
  fields: Pick<BeaconBody, 'kind' | 'port' | 'presence' | 'profileVer' | 'ts'>,
): Uint8Array {
  const body: BeaconBody = {
    v: PROTOCOL_VERSION,
    userId: signer.userId,
    pub: encodeBase64Url(signer.spki),
    ...fields,
  };
  const bytes = Buffer.from(JSON.stringify(signRecord(signer.privateKey, body)), 'utf8');
  if (bytes.length > MAX_BEACON_BYTES) throw new Error(`beacon is ${bytes.length} bytes`);
  return bytes;
}

export type BeaconRejection =
  'too-large' | 'malformed' | 'bad-key' | 'bad-signature' | 'clock-skew';

export type BeaconVerdict =
  | { ok: true; beacon: SignedBeacon; spki: Buffer; publicKey: KeyObject }
  | { ok: false; reason: BeaconRejection; userId?: string };

interface Verified {
  beacon: SignedBeacon;
  spki: Buffer;
  publicKey: KeyObject;
}

const CACHE_LIMIT = 4_096;

/**
 * Verifies beacons from the network: size, key matches userId, signature over the raw
 * record, schema, clock skew. Identical datagrams (the same beacon via multicast and
 * broadcast, or on several interfaces) are verified once.
 */
export class BeaconVerifier {
  private readonly seen = new Map<string, Verified>();
  private readonly keys = new Map<string, { publicKey: KeyObject; spki: Buffer; userId: string }>();

  verify(datagram: Uint8Array, now: number): BeaconVerdict {
    if (datagram.length > MAX_BEACON_BYTES) return { ok: false, reason: 'too-large' };
    const text = Buffer.from(datagram.buffer, datagram.byteOffset, datagram.byteLength).toString(
      'utf8',
    );
    let verified = this.seen.get(text);
    if (!verified) {
      const result = this.verifyFresh(text);
      if (!('beacon' in result)) return result;
      verified = result;
      if (this.seen.size >= CACHE_LIMIT) this.seen.delete(this.seen.keys().next().value!);
      this.seen.set(text, verified);
    }
    if (Math.abs(verified.beacon.ts - now) > MAX_BEACON_CLOCK_SKEW_MS) {
      return { ok: false, reason: 'clock-skew', userId: verified.beacon.userId };
    }
    return { ok: true, ...verified };
  }

  private verifyFresh(text: string): Verified | { ok: false; reason: BeaconRejection } {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'malformed' };
    const record = raw as Record<string, unknown>;
    if (typeof record['pub'] !== 'string' || typeof record['userId'] !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    const key = this.key(record['pub']);
    if (!key || key.userId !== record['userId']) return { ok: false, reason: 'bad-key' };
    if (!verifyRecord(key.publicKey, raw)) return { ok: false, reason: 'bad-signature' };
    const parsed = SignedBeacon.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'malformed' };
    return { beacon: parsed.data, spki: key.spki, publicKey: key.publicKey };
  }

  private key(pub: string) {
    let entry = this.keys.get(pub);
    if (!entry) {
      try {
        const spki = Buffer.from(decodeBase64Url(pub));
        entry = { publicKey: importPublicKeySpki(spki), spki, userId: userIdFromSpki(spki) };
      } catch {
        return undefined;
      }
      if (this.keys.size >= CACHE_LIMIT) this.keys.delete(this.keys.keys().next().value!);
      this.keys.set(pub, entry);
    }
    return entry;
  }
}

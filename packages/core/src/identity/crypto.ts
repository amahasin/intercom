/**
 * The only crypto entry points in the codebase (plan section 17, rule 6). ECDSA P-256 with
 * SHA-256, signatures in IEEE P1363 form, over canonical JSON. No custom algorithms.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  decodeBase64Url,
  encodeBase32,
  encodeBase64Url,
  signingPayload,
} from '@officemesh/protocol';

/** DER length of a P-256 SubjectPublicKeyInfo with an uncompressed point. */
export const P256_SPKI_LENGTH = 91;

export interface IdentityKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** SubjectPublicKeyInfo DER: the canonical public key bytes that userId hashes. */
  spki: Buffer;
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, publicKey, spki: publicKey.export({ type: 'spki', format: 'der' }) };
}

export function exportPrivateKeyPkcs8(key: KeyObject): Buffer {
  return key.export({ type: 'pkcs8', format: 'der' });
}

export function importPrivateKeyPkcs8(der: Uint8Array): IdentityKeyPair {
  const privateKey = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' });
  assertP256(privateKey);
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, spki: publicKey.export({ type: 'spki', format: 'der' }) };
}

/** Parse peer-supplied SPKI bytes, accepting only P-256 keys. */
export function importPublicKeySpki(spki: Uint8Array): KeyObject {
  if (spki.length !== P256_SPKI_LENGTH) throw new Error('public key is not a P-256 SPKI');
  const key = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
  assertP256(key);
  return key;
}

function assertP256(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('key is not ECDSA P-256');
  }
}

/** userId = first 20 bytes of SHA-256 over the SPKI public key, base32 (32 chars). */
export function userIdFromSpki(spki: Uint8Array): string {
  return encodeBase32(sha256(spki).subarray(0, 20));
}

export function signText(privateKey: KeyObject, text: string): string {
  const sig = sign('sha256', Buffer.from(text, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return encodeBase64Url(sig);
}

export function verifyText(publicKey: KeyObject, text: string, sigB64: string): boolean {
  try {
    const sig = decodeBase64Url(sigB64);
    if (sig.length !== 64) return false;
    return verify(
      'sha256',
      Buffer.from(text, 'utf8'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      sig,
    );
  } catch {
    return false;
  }
}

/** Return a copy of `record` with `sig` set over its canonical JSON. */
export function signRecord<T extends Record<string, unknown>>(
  privateKey: KeyObject,
  record: T,
): T & { sig: string } {
  return { ...record, sig: signText(privateKey, signingPayload(record)) };
}

/**
 * Verify a signed record exactly as received, before schema parsing strips unknown
 * fields. Returns false for anything malformed.
 */
export function verifyRecord(publicKey: KeyObject, raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  if (typeof record['sig'] !== 'string') return false;
  try {
    return verifyText(publicKey, signingPayload(record), record['sig']);
  } catch {
    return false;
  }
}

/**
 * The only crypto entry points in the codebase (plan section 17, rule 6). ECDSA P-256 with
 * SHA-256, signatures in IEEE P1363 form, over canonical JSON. No custom algorithms.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  pbkdf2,
  randomBytes,
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

// ---------------------------------------------------------------------------
// Sealing (M6): ECDH P-256 + HKDF-SHA256 + AES-256-GCM, and a passphrase key for exports
// ---------------------------------------------------------------------------

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export interface Sealed {
  /** The sender's one-time public key (SPKI DER). */
  epk: Buffer;
  iv: Buffer;
  /** Ciphertext followed by the 16-byte GCM tag. */
  ct: Buffer;
}

function aesGcmEncrypt(
  key: Buffer,
  plaintext: Uint8Array,
  aad: string,
): { iv: Buffer; ct: Buffer } {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv, ct };
}

function aesGcmDecrypt(key: Buffer, iv: Uint8Array, ct: Uint8Array, aad: string): Buffer {
  if (iv.length !== GCM_IV_BYTES || ct.length < GCM_TAG_BYTES)
    throw new Error('malformed sealed data');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(ct.subarray(ct.length - GCM_TAG_BYTES)));
  return Buffer.concat([
    decipher.update(ct.subarray(0, ct.length - GCM_TAG_BYTES)),
    decipher.final(),
  ]);
}

function envelopeKey(shared: Buffer, epk: Uint8Array, aad: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, epk, `officemesh/envelope/v1\0${aad}`, 32));
}

/**
 * Seal bytes so only the holder of `recipient`'s private key can read them: a one-time
 * P-256 key pair, ECDH with the recipient's identity key, HKDF-SHA256, then AES-256-GCM.
 * `aad` (bound into the key and authenticated) carries the clear-text routing fields.
 */
export function sealFor(recipient: KeyObject, plaintext: Uint8Array, aad: string): Sealed {
  const eph = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const epk = eph.publicKey.export({ type: 'spki', format: 'der' });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const { iv, ct } = aesGcmEncrypt(envelopeKey(shared, epk, aad), plaintext, aad);
  return { epk, iv, ct };
}

/** Open what `sealFor` sealed to this identity; throws if the key or any byte is wrong. */
export function openSealed(privateKey: KeyObject, sealed: Sealed, aad: string): Buffer {
  const epk = importPublicKeySpki(sealed.epk);
  const shared = diffieHellman({ privateKey, publicKey: epk });
  return aesGcmDecrypt(envelopeKey(shared, sealed.epk, aad), sealed.iv, sealed.ct, aad);
}

/** PBKDF2-HMAC-SHA256 iterations for a profile export passphrase (OWASP 2023 figure). */
export const EXPORT_KDF_ITERATIONS = 600_000;

function passphraseKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    pbkdf2(passphrase.normalize('NFC'), salt, iterations, 32, 'sha256', (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Encrypt bytes under a passphrase: PBKDF2-HMAC-SHA256, then AES-256-GCM. */
export async function encryptWithPassphrase(
  passphrase: string,
  plaintext: Uint8Array,
  aad: string,
): Promise<{ salt: Buffer; iterations: number; iv: Buffer; ct: Buffer }> {
  const salt = randomBytes(16);
  const key = await passphraseKey(passphrase, salt, EXPORT_KDF_ITERATIONS);
  return { salt, iterations: EXPORT_KDF_ITERATIONS, ...aesGcmEncrypt(key, plaintext, aad) };
}

/** Throws if the passphrase is wrong or the data was changed. */
export async function decryptWithPassphrase(
  passphrase: string,
  sealed: { salt: Uint8Array; iterations: number; iv: Uint8Array; ct: Uint8Array },
  aad: string,
): Promise<Buffer> {
  if (sealed.iterations < 100_000 || sealed.iterations > 10_000_000)
    throw new Error('unsupported key strength');
  const key = await passphraseKey(passphrase, sealed.salt, sealed.iterations);
  return aesGcmDecrypt(key, sealed.iv, sealed.ct, aad);
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

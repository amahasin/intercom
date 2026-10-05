import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { UserId } from '@officemesh/protocol';
import {
  certificateMatchesUserId,
  certificateUserId,
  createSelfSignedCertificate,
  exportPrivateKeyPkcs8,
  generateIdentityKeyPair,
  importPrivateKeyPkcs8,
  importPublicKeySpki,
  safetyPhrase,
  signRecord,
  userIdFromSpki,
  verifyRecord,
} from '../src/index.ts';

describe('identity keys', () => {
  it('derives a stable 32-char base32 userId from the SPKI public key', () => {
    const keys = generateIdentityKeyPair();
    const id = userIdFromSpki(keys.spki);
    expect(UserId.safeParse(id).success).toBe(true);
    expect(userIdFromSpki(keys.spki)).toBe(id);
    expect(keys.spki).toHaveLength(91);
  });

  it('round-trips the private key through PKCS#8', () => {
    const keys = generateIdentityKeyPair();
    const again = importPrivateKeyPkcs8(exportPrivateKeyPkcs8(keys.privateKey));
    expect(again.spki.equals(keys.spki)).toBe(true);
  });

  it('refuses keys on other curves', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    expect(() =>
      importPrivateKeyPkcs8(privateKey.export({ type: 'pkcs8', format: 'der' })),
    ).toThrow();
    expect(() => importPublicKeySpki(publicKey.export({ type: 'spki', format: 'der' }))).toThrow();
  });
});

describe('signed records', () => {
  const keys = generateIdentityKeyPair();

  it('verifies regardless of key order and rejects tampering', () => {
    const signed = signRecord(keys.privateKey, { b: 2, a: 'x', nested: { z: 1, y: [1, 2] } });
    const reordered = JSON.parse(
      JSON.stringify({ nested: signed.nested, sig: signed.sig, a: signed.a, b: signed.b }),
    );
    expect(verifyRecord(keys.publicKey, reordered)).toBe(true);
    expect(verifyRecord(keys.publicKey, { ...signed, b: 3 })).toBe(false);
    expect(verifyRecord(keys.publicKey, { ...signed, extra: true })).toBe(false);
  });

  it('rejects a signature from another key', () => {
    const other = generateIdentityKeyPair();
    const signed = signRecord(other.privateKey, { a: 1 });
    expect(verifyRecord(keys.publicKey, signed)).toBe(false);
  });

  it('never throws on garbage', () => {
    for (const raw of [null, 1, 'x', [], {}, { sig: 5 }, { sig: '!!!' }, { sig: 'A'.repeat(86) }]) {
      expect(verifyRecord(keys.publicKey, raw)).toBe(false);
    }
  });
});

describe('certificate', () => {
  it('binds the self-signed certificate to the userId', async () => {
    const keys = generateIdentityKeyPair();
    const userId = userIdFromSpki(keys.spki);
    const pem = await createSelfSignedCertificate(userId, keys.privateKey, keys.publicKey);
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(certificateUserId(pem)).toBe(userId);
    expect(certificateMatchesUserId(pem, userId)).toBe(true);
  });

  it('does not match a different userId or garbage', async () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    const pem = await createSelfSignedCertificate(
      userIdFromSpki(a.spki),
      a.privateKey,
      a.publicKey,
    );
    expect(certificateMatchesUserId(pem, userIdFromSpki(b.spki))).toBe(false);
    expect(certificateMatchesUserId('not a cert', userIdFromSpki(a.spki))).toBe(false);
  });
});

describe('safety phrase', () => {
  it('is six dictionary words, deterministic per key, different across keys', () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    const phrase = safetyPhrase(a.spki);
    expect(phrase).toHaveLength(6);
    for (const word of phrase) expect(word).toMatch(/^[a-z]+$/);
    expect(safetyPhrase(a.spki)).toEqual(phrase);
    expect(safetyPhrase(b.spki)).not.toEqual(phrase);
  });
});

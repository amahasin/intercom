// @peculiar/x509 resolves its algorithm providers through tsyringe, which needs this polyfill
// loaded first. ESM evaluates imports in order, so it must stay the first import.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { randomBytes, webcrypto, X509Certificate, type KeyObject } from 'node:crypto';
import { userIdFromSpki } from './crypto.ts';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const CERT_LIFETIME_YEARS = 30;
const EC_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/**
 * Self-signed X.509 certificate for mutual TLS, built from the identity key. Peers ignore
 * chains and only check that the certificate's key hashes to the userId they expected.
 */
export async function createSelfSignedCertificate(
  userId: string,
  privateKey: KeyObject,
  publicKey: KeyObject,
  now: Date = new Date(),
): Promise<string> {
  const notBefore = new Date(now.getTime() - 24 * 3600_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + CERT_LIFETIME_YEARS);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    // Positive 128-bit serial: clear the top bit so DER does not read it as negative.
    serialNumber:
      (randomBytes(16)[0]! & 0x7f).toString(16).padStart(2, '0') + randomBytes(15).toString('hex'),
    name: `CN=${userId}, O=OfficeMesh`,
    notBefore,
    notAfter,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys: {
      privateKey: privateKey.toCryptoKey(EC_ALG, false, ['sign']),
      publicKey: publicKey.toCryptoKey(EC_ALG, true, ['verify']),
    },
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([
        x509.ExtendedKeyUsage.serverAuth,
        x509.ExtendedKeyUsage.clientAuth,
      ]),
    ],
  });
  return cert.toString('pem');
}

/** The userId a certificate's public key belongs to. Throws on unparseable input. */
export function certificateUserId(cert: string | Uint8Array): string {
  const parsed = new X509Certificate(typeof cert === 'string' ? cert : Buffer.from(cert));
  return userIdFromSpki(parsed.publicKey.export({ type: 'spki', format: 'der' }));
}

/** True when the certificate's key hashes to `expectedUserId`. Never throws. */
export function certificateMatchesUserId(
  cert: string | Uint8Array,
  expectedUserId: string,
): boolean {
  try {
    return certificateUserId(cert) === expectedUserId;
  } catch {
    return false;
  }
}

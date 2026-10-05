import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { decodeBase64Url, encodeBase64Url, SignedProfile } from '@officemesh/protocol';
import type { Clock, KeyProtector, Logger } from '../interfaces.ts';
import type { Store } from '../store/store.ts';
import { createSelfSignedCertificate } from './certificate.ts';
import {
  exportPrivateKeyPkcs8,
  generateIdentityKeyPair,
  importPrivateKeyPkcs8,
  userIdFromSpki,
  type IdentityKeyPair,
} from './crypto.ts';
import { signProfile } from './profile.ts';
import { safetyPhrase } from './safety-phrase.ts';

export const KEY_FILE_NAME = 'identity.key';

/** On-disk wrapper around the sealed PKCS#8 private key. Never holds the plaintext key. */
const KeyFile = z.object({
  v: z.literal(1),
  scheme: z.enum(['safeStorage', 'insecure-test']),
  sealed: z.string().min(1),
});

export interface Identity {
  readonly userId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly spki: Buffer;
  readonly certPem: string;
  readonly createdAt: number;
  readonly safetyPhrase: string[];
  profile: SignedProfile;
}

export interface IdentityDeps {
  store: Store;
  dataDir: string;
  protector: KeyProtector;
  clock: Clock;
  logger: Logger;
  /** Display name for a brand-new identity. Only called on first run. */
  defaultDisplayName: () => Promise<string>;
}

/** Load this profile's identity, or generate one on first run. */
export async function loadOrCreateIdentity(deps: IdentityDeps): Promise<Identity> {
  const keyPath = join(deps.dataDir, KEY_FILE_NAME);
  const row = deps.store.getIdentity();
  const keyExists = existsSync(keyPath);

  if (row && !keyExists) {
    throw new Error(
      `identity key file is missing (${keyPath}); refusing to create a new identity over an existing one`,
    );
  }

  if (row) {
    const keys = await readKeyFile(keyPath, deps.protector);
    const userId = userIdFromSpki(keys.spki);
    if (userId !== row.userId || !keys.spki.equals(row.publicKey)) {
      throw new Error('identity key file does not match the identity in the database');
    }
    const profile = SignedProfile.parse(JSON.parse(row.profileJson));
    return build(keys, userId, row.certPem, row.createdAt, profile);
  }

  // First run (or a database lost while the key survived: keep the key, re-issue the rest).
  const keys = keyExists ? await readKeyFile(keyPath, deps.protector) : generateIdentityKeyPair();
  const userId = userIdFromSpki(keys.spki);
  const now = deps.clock.now();
  const certPem = await createSelfSignedCertificate(
    userId,
    keys.privateKey,
    keys.publicKey,
    new Date(now),
  );
  const profile = signProfile(keys.privateKey, {
    userId,
    version: 1,
    displayName: (await deps.defaultDisplayName()).trim() || 'Colleague',
    updatedAt: now,
  });
  if (!keyExists) await writeKeyFile(keyPath, keys, deps.protector);
  deps.store.insertIdentity({
    userId,
    publicKey: keys.spki,
    certPem,
    profileJson: JSON.stringify(profile),
    createdAt: now,
  });
  deps.logger.info(keyExists ? 'identity restored from key file' : 'identity created', { userId });
  return build(keys, userId, certPem, now, profile);
}

function build(
  keys: IdentityKeyPair,
  userId: string,
  certPem: string,
  createdAt: number,
  profile: SignedProfile,
): Identity {
  return {
    userId,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    spki: keys.spki,
    certPem,
    createdAt,
    safetyPhrase: safetyPhrase(keys.spki),
    profile,
  };
}

async function readKeyFile(path: string, protector: KeyProtector): Promise<IdentityKeyPair> {
  const file = KeyFile.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (file.scheme !== protector.scheme) {
    throw new Error(
      `identity key was sealed with ${file.scheme}, but this host provides ${protector.scheme}`,
    );
  }
  const plain = await protector.unprotect(decodeBase64Url(file.sealed));
  try {
    return importPrivateKeyPkcs8(plain);
  } finally {
    plain.fill(0);
  }
}

/** Seal a private key with this PC's protector and write it as the profile's key file. */
export async function writeIdentityKeyFile(
  path: string,
  keys: IdentityKeyPair,
  protector: KeyProtector,
): Promise<void> {
  return writeKeyFile(path, keys, protector);
}

async function writeKeyFile(
  path: string,
  keys: IdentityKeyPair,
  protector: KeyProtector,
): Promise<void> {
  const plain = exportPrivateKeyPkcs8(keys.privateKey);
  let sealed: Uint8Array;
  try {
    sealed = await protector.protect(plain);
  } finally {
    plain.fill(0);
  }
  const body = JSON.stringify({ v: 1, scheme: protector.scheme, sealed: encodeBase64Url(sealed) });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  renameSync(tmp, path);
}

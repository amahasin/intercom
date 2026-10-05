import type { KeyObject } from 'node:crypto';
import { ProfileBody, SignedProfile, type ProfileEdit } from '@officemesh/protocol';
import { signRecord, verifyRecord } from './crypto.ts';

export function signProfile(privateKey: KeyObject, body: ProfileBody): SignedProfile {
  return signRecord(privateKey, ProfileBody.parse(body));
}

/**
 * Check a profile received from a peer: signature over the raw record, then schema, then
 * that it belongs to the expected user. Returns the parsed profile or undefined.
 */
export function verifyProfile(
  raw: unknown,
  expectedUserId: string,
  publicKey: KeyObject,
): SignedProfile | undefined {
  if (!verifyRecord(publicKey, raw)) return undefined;
  const parsed = SignedProfile.safeParse(raw);
  if (!parsed.success || parsed.data.userId !== expectedUserId) return undefined;
  return parsed.data;
}

/** Apply a local edit: bump the version, re-sign. */
export function editProfile(
  privateKey: KeyObject,
  current: SignedProfile,
  edit: ProfileEdit,
  now: number,
): SignedProfile {
  const { sig: _sig, ...body } = current;
  const next: ProfileBody = { ...body, version: current.version + 1, updatedAt: now };
  if (edit.displayName !== undefined) next.displayName = edit.displayName;
  if (edit.jobTitle !== undefined) setOrDrop(next, 'jobTitle', edit.jobTitle);
  if (edit.statusMessage !== undefined) setOrDrop(next, 'statusMessage', edit.statusMessage);
  if (edit.statusExpiresAt === null) delete next.statusExpiresAt;
  else if (edit.statusExpiresAt !== undefined) next.statusExpiresAt = edit.statusExpiresAt;
  return signProfile(privateKey, next);
}

function setOrDrop(target: ProfileBody, key: 'jobTitle' | 'statusMessage', value: string): void {
  if (value === '') delete target[key];
  else target[key] = value;
}

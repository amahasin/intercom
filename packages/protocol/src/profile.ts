import { z } from 'zod';
import { EpochMs, Sha256Hex, SignatureB64, UserId } from './common.ts';

/**
 * A user's profile is a signed record with a version number; the highest version wins.
 * Optional fields are omitted rather than defaulted so the signed bytes stay stable.
 */
export const ProfileBody = z.object({
  userId: UserId,
  version: z.number().int().min(1),
  displayName: z.string().trim().min(1).max(64),
  jobTitle: z.string().trim().max(64).optional(),
  statusMessage: z.string().max(280).optional(),
  statusExpiresAt: EpochMs.optional(),
  avatarHash: Sha256Hex.optional(),
  updatedAt: EpochMs,
});
export type ProfileBody = z.infer<typeof ProfileBody>;

export const SignedProfile = ProfileBody.extend({ sig: SignatureB64 });
export type SignedProfile = z.infer<typeof SignedProfile>;

/** Fields a user may edit locally. */
export const ProfileEdit = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  jobTitle: z.string().trim().max(64).optional(),
  statusMessage: z.string().max(280).optional(),
  statusExpiresAt: EpochMs.nullable().optional(),
  avatarHash: Sha256Hex.nullable().optional(),
});
export type ProfileEdit = z.infer<typeof ProfileEdit>;

export const MAX_AVATAR_BYTES = 128 * 1024;

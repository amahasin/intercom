import { z } from 'zod';
import { EpochMs, Sha256Hex, SignatureB64, UserId } from './common.ts';

/**
 * A user's profile is a signed record with a version number; the highest version wins.
 * Optional fields are omitted rather than defaulted so the signed bytes stay stable.
 */
/** The longest note a profile holds (about a dozen lines). */
export const MAX_NOTES = 1000;

export const ProfileBody = z.object({
  userId: UserId,
  version: z.number().int().min(1),
  displayName: z.string().trim().min(1).max(64),
  jobTitle: z.string().trim().max(64).optional(),
  statusMessage: z.string().max(280).optional(),
  statusExpiresAt: EpochMs.optional(),
  avatarHash: Sha256Hex.optional(),
  /** Where to reach the person (shown on their page). Whatever a newer version sends is kept as text. */
  email: z.string().max(120).optional(),
  /** Where they are working today: office or home (anything else a newer version sends is kept as text and not shown). */
  workplace: z.string().max(16).optional(),
  /** Whatever the person wants colleagues to know, over several lines (shown on their page). */
  notes: z.string().max(MAX_NOTES).optional(),
  updatedAt: EpochMs,
});
export type ProfileBody = z.infer<typeof ProfileBody>;

export const SignedProfile = ProfileBody.extend({ sig: SignatureB64 });
export type SignedProfile = z.infer<typeof SignedProfile>;

/**
 * An email address as people write them: something, an @, a domain with a dot. Not a full check
 * (nothing is sent by InterCom); it is there so a typo is caught and so a link can be trusted.
 */
export const EMAIL_PATTERN =
  /^[^\s@<>"'()[\],;:\\]+@[^\s@<>"'()[\],;:\\]+\.[^\s@<>"'()[\],;:\\]{2,}$/;

/** Where someone works today: a value the app knows (office or home), not whatever text arrived. */
export type Workplace = 'office' | 'home';
export const isWorkplace = (value: unknown): value is Workplace =>
  value === 'office' || value === 'home';

/** Fields a user may edit locally. */
export const ProfileEdit = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  jobTitle: z.string().trim().max(64).optional(),
  statusMessage: z.string().max(280).optional(),
  /** Empty clears it. */
  email: z
    .string()
    .trim()
    .max(120)
    .refine(
      (v) => v === '' || EMAIL_PATTERN.test(v),
      'Enter an email address like name@company.com',
    )
    .optional(),
  /** office, home, or empty to say nothing. */
  workplace: z.enum(['office', 'home', '']).optional(),
  /** Empty clears it. */
  notes: z.string().max(MAX_NOTES).optional(),
  statusExpiresAt: EpochMs.nullable().optional(),
  avatarHash: Sha256Hex.nullable().optional(),
});
export type ProfileEdit = z.infer<typeof ProfileEdit>;

export const MAX_AVATAR_BYTES = 128 * 1024;

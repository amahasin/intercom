import { z } from 'zod';

/** Wire protocol version carried in beacons, `hello` and envelopes. */
export const PROTOCOL_VERSION = 1;

/** 20 bytes of SHA-256 over the SPKI public key, base32 lowercase: always 32 characters. */
export const UserId = z.string().regex(/^[a-z2-7]{32}$/, 'invalid userId');
export type UserId = z.infer<typeof UserId>;

export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, 'invalid base64url');

/** SPKI DER of an ECDSA P-256 key (91 bytes), base64url: 122 characters. */
export const PublicKeyB64 = Base64Url.length(122);

/** ECDSA P-256 signature in IEEE P1363 form (r || s, 64 bytes), base64url: 86 characters. */
export const SignatureB64 = Base64Url.length(86);

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'invalid sha256');

/** Milliseconds since the Unix epoch. */
export const EpochMs = z.number().int().nonnegative();

/** Profile names are folder names, so keep them to a safe character set. */
export const ProfileName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'invalid profile name');

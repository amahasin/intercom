import { randomBytes } from 'node:crypto';
import { canonicalJson, encodeBase32, encodeBase64Url } from '@officemesh/protocol';
import { sha256 } from '../identity/crypto.ts';

const id = (text: string) => encodeBase32(sha256(text).subarray(0, 20));

/**
 * A group's or team's conversation ID: a hash of its genesis event's type, author and
 * body (which includes a random nonce). Receiving the genesis proves who created it, and
 * nobody can claim to have created an existing conversation.
 */
export function genesisConvId(
  type: 'group.create' | 'team.create',
  author: string,
  body: unknown,
): string {
  return id(`officemesh/conv/v1\0${type}\0${author}\0${canonicalJson(body)}`);
}

/** A channel's conversation ID, bound to its team, creator and nonce. */
export function channelConvId(teamId: string, author: string, nonce: string): string {
  return id(`officemesh/channel/v1\0${teamId}\0${author}\0${nonce}`);
}

/** The General channel, created with the team (its ID cannot depend on the team ID). */
export function generalChannelId(author: string, teamNonce: string): string {
  return id(`officemesh/general/v1\0${author}\0${teamNonce}`);
}

export function newNonce(): string {
  return encodeBase64Url(randomBytes(16));
}

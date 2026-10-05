import { encodeBase32 } from '@officemesh/protocol';
import { sha256 } from '../identity/crypto.ts';

/**
 * The conversation ID two people share for their 1:1 chat. Both sides derive the same ID
 * without coordinating, so either can start the chat while the other is offline.
 */
export function directConvId(a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return encodeBase32(sha256(`officemesh/direct/v1\0${x}\0${y}`).subarray(0, 20));
}

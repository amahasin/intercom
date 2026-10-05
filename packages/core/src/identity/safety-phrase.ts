import { wordlist } from '@scure/bip39/wordlists/english.js';
import { sha256 } from './crypto.ts';

const DOMAIN = 'officemesh/safety-phrase/v1\0';
export const SAFETY_PHRASE_WORDS = 6;

/**
 * Six words derived from a public key, for colleagues to compare in person.
 * 6 words x 11 bits from a 2048-word list = 66 bits of the key's domain-separated hash.
 */
export function safetyPhrase(spki: Uint8Array): string[] {
  if (wordlist.length !== 2048) throw new Error('safety phrase wordlist must have 2048 words');
  const digest = sha256(Buffer.concat([Buffer.from(DOMAIN, 'utf8'), Buffer.from(spki)]));
  let bits = 0n;
  for (const byte of digest.subarray(0, 9)) bits = (bits << 8n) | BigInt(byte); // 72 bits
  const words: string[] = [];
  for (let i = 0; i < SAFETY_PHRASE_WORDS; i++) {
    const shift = BigInt(72 - 11 * (i + 1));
    words.push(wordlist[Number((bits >> shift) & 0x7ffn)]!);
  }
  return words;
}

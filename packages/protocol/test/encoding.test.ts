import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decodeBase32,
  decodeBase64Url,
  encodeBase32,
  encodeBase64Url,
  signingPayload,
} from '../src/index.ts';

describe('base32', () => {
  it('matches RFC 4648 test vectors (lowercase, unpadded)', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'my'],
      ['fo', 'mzxq'],
      ['foo', 'mzxw6'],
      ['foob', 'mzxw6yq'],
      ['fooba', 'mzxw6ytb'],
      ['foobar', 'mzxw6ytboi'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(encodeBase32(new TextEncoder().encode(plain))).toBe(encoded);
      expect(new TextDecoder().decode(decodeBase32(encoded))).toBe(plain);
    }
  });

  it('encodes 20 bytes to exactly 32 characters', () => {
    expect(encodeBase32(new Uint8Array(20).fill(0xab))).toHaveLength(32);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => decodeBase32('abc1')).toThrow();
  });
});

describe('base64url', () => {
  it('matches RFC 4648 vectors with the url-safe alphabet', () => {
    const enc = (s: string) => encodeBase64Url(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('Zg');
    expect(enc('fo')).toBe('Zm8');
    expect(enc('foo')).toBe('Zm9v');
    expect(enc('foobar')).toBe('Zm9vYmFy');
    expect(encodeBase64Url(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe('-_-_');
  });

  it('round-trips every length from 0 to 70 bytes', () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(Array.from(decodeBase64Url(encodeBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('is independent of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 'two' })).toBe(canonicalJson({ y: 'two', x: 1 }));
  });

  it('rejects values that JSON cannot carry faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
  });

  it('signingPayload excludes only the sig field', () => {
    expect(signingPayload({ sig: 'x', b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});

import { describe, expect, it } from 'vitest';
import {
  BeaconBody,
  EVENT_BODIES,
  EVENT_TYPES,
  LogEvent,
  MAX_BEACON_BYTES,
  SignedBeacon,
  SignedProfile,
  UserId,
  WIRE_BODIES,
  WIRE_TYPES,
  WireEnvelope,
} from '../src/index.ts';

const userId = 'abcdefghijklmnopqrstuvwxyz234567';
const pub = 'A'.repeat(122);
const sig = 'B'.repeat(86);

describe('identifiers', () => {
  it('accepts a 32-char base32 userId and rejects anything else', () => {
    expect(UserId.safeParse(userId).success).toBe(true);
    expect(UserId.safeParse(userId.toUpperCase()).success).toBe(false);
    expect(UserId.safeParse(userId.slice(1)).success).toBe(false);
    expect(UserId.safeParse(userId.slice(1) + '1').success).toBe(false);
  });
});

describe('beacon', () => {
  const beacon: SignedBeacon = {
    v: 1,
    kind: 'alive',
    userId,
    pub,
    port: 47801,
    presence: 'available',
    profileVer: 3,
    ts: 1_790_000_000_000,
    sig,
  };

  it('round-trips through JSON', () => {
    expect(SignedBeacon.parse(JSON.parse(JSON.stringify(beacon)))).toEqual(beacon);
  });

  it('fits under the 512-byte budget', () => {
    expect(new TextEncoder().encode(JSON.stringify(beacon)).length).toBeLessThan(MAX_BEACON_BYTES);
  });

  it('rejects an out-of-range port and an unknown presence', () => {
    expect(BeaconBody.safeParse({ ...beacon, port: 70000 }).success).toBe(false);
    expect(BeaconBody.safeParse({ ...beacon, presence: 'sleeping' }).success).toBe(false);
  });
});

describe('profile', () => {
  it('trims names and rejects empty ones', () => {
    const base = { userId, version: 1, updatedAt: 1, sig };
    expect(SignedProfile.parse({ ...base, displayName: '  Asha  ' }).displayName).toBe('Asha');
    expect(SignedProfile.safeParse({ ...base, displayName: '   ' }).success).toBe(false);
  });
});

describe('wire envelope', () => {
  it('accepts unknown types so newer peers do not break older ones', () => {
    const env = { v: 1, type: 'future.thing', id: 'm1', body: { anything: true } };
    expect(WireEnvelope.parse(env)).toEqual(env);
  });

  it('only defines bodies for known types', () => {
    for (const type of Object.keys(WIRE_BODIES)) expect(WIRE_TYPES).toContain(type);
  });
});

describe('log event', () => {
  it('round-trips a msg.post', () => {
    const ev = {
      convId: userId,
      author: userId,
      seq: 1,
      hlc: { t: 1_790_000_000_000, c: 0 },
      type: 'msg.post',
      body: { text: 'hello' },
      sig,
    };
    expect(LogEvent.parse(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
    expect(EVENT_BODIES['msg.post'].parse(ev.body)).toEqual({ text: 'hello' });
  });

  it('rejects seq 0', () => {
    expect(
      LogEvent.safeParse({
        convId: userId,
        author: userId,
        seq: 0,
        hlc: { t: 0, c: 0 },
        type: 'msg.post',
        body: {},
        sig,
      }).success,
    ).toBe(false);
  });

  it('only defines bodies for known types', () => {
    for (const type of Object.keys(EVENT_BODIES)) expect(EVENT_TYPES).toContain(type);
  });
});

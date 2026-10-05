import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, QrError } from '../../backend/shared/qr';

// Throw-away keys generated for the test only. Nothing here is the real deployed secret.
const SECRET = 'unit-test-secret-unit-test-secret-0123456789';
const OTHER = 'a-different-secret-a-different-secret-987654321';
const TID = '11111111-1111-4111-8111-111111111111';
const EID = '22222222-2222-4222-8222-222222222222';
const now = 1_800_000_000;
const good = () => signToken(SECRET, { tid: TID, eid: EID, exp: now + 3600 });

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as QrError).code;
  }
  return 'NO_ERROR';
};
const b64u = (s: string) => Buffer.from(s).toString('base64url');

describe('QR token', () => {
  it('round-trips a valid token', () => {
    expect(verifyToken(SECRET, good(), now)).toEqual({ tid: TID, eid: EID, exp: now + 3600 });
  });

  it('contains only ticket id, event id and expiry (no personal data)', () => {
    const payload = JSON.parse(Buffer.from(good().split('.')[1]!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['eid', 'exp', 'tid']);
  });

  it('is short enough for a QR code', () => {
    expect(good().length).toBeLessThan(250);
  });

  it('rejects a token signed with a different key (forged)', () => {
    const forged = signToken(OTHER, { tid: TID, eid: EID, exp: now + 3600 });
    expect(code(() => verifyToken(SECRET, forged, now))).toBe('INVALID');
  });

  it('rejects an edited payload with the old signature', () => {
    const [v, , sig] = good().split('.');
    const edited = (patch: object) =>
      `${v}.${b64u(JSON.stringify({ tid: TID, eid: EID, exp: now + 3600, ...patch }))}.${sig}`;
    expect(code(() => verifyToken(SECRET, edited({ tid: '33333333-3333-4333-8333-333333333333' }), now))).toBe('INVALID');
    expect(code(() => verifyToken(SECRET, edited({ eid: '33333333-3333-4333-8333-333333333333' }), now))).toBe('INVALID');
    expect(code(() => verifyToken(SECRET, edited({ exp: now + 999_999_999 }), now))).toBe('INVALID');
  });

  it('rejects a flipped bit anywhere in the token', () => {
    const t = good();
    for (const i of [0, 5, 20, t.length - 3, t.length - 1]) {
      const chars = t.split('');
      chars[i] = chars[i] === 'A' ? 'B' : 'A';
      expect(code(() => verifyToken(SECRET, chars.join(''), now)), `position ${i}`).toBe('INVALID');
    }
  });

  it('rejects an expired token with the EXPIRED code', () => {
    const old = signToken(SECRET, { tid: TID, eid: EID, exp: now - 1 });
    expect(code(() => verifyToken(SECRET, old, now))).toBe('EXPIRED');
    const atBoundary = signToken(SECRET, { tid: TID, eid: EID, exp: now });
    expect(code(() => verifyToken(SECRET, atBoundary, now))).toBe('EXPIRED');
  });

  it('checks the signature before the expiry (a forged expired token is just INVALID)', () => {
    const forgedOld = signToken(OTHER, { tid: TID, eid: EID, exp: now - 1000 });
    expect(code(() => verifyToken(SECRET, forgedOld, now))).toBe('INVALID');
  });

  it.each([
    ['empty', ''],
    ['random text', 'hello'],
    ['two parts', 'v1.abc'],
    ['four parts', 'v1.a.b.c'],
    ['wrong version', 'v2.abc.def'],
    ['missing signature', `v1.${b64u('{}')}.`],
    ['alg none style', `none.${b64u('{}')}.`],
    ['huge', 'v1.' + 'a'.repeat(1000) + '.b'],
    ['not a string', 12345],
    ['null', null],
  ])('rejects malformed token: %s', (_l, tok) => {
    expect(code(() => verifyToken(SECRET, tok, now))).toBe('INVALID');
  });

  it('rejects a correctly signed payload with the wrong shape', () => {
    const sign = (obj: unknown) => {
      const body = `v1.${b64u(JSON.stringify(obj))}`;
      // reuse signToken's MAC by signing a dummy then re-signing manually is not possible, so build with node crypto
      const { createHmac } = require('node:crypto') as typeof import('node:crypto');
      return `${body}.${createHmac('sha256', SECRET).update(body).digest().toString('base64url')}`;
    };
    expect(code(() => verifyToken(SECRET, sign({ tid: 'not-a-uuid', eid: EID, exp: now + 10 }), now))).toBe('INVALID');
    expect(code(() => verifyToken(SECRET, sign({ tid: TID, eid: EID, exp: 'soon' }), now))).toBe('INVALID');
    expect(code(() => verifyToken(SECRET, sign({ tid: TID, eid: EID }), now))).toBe('INVALID');
    expect(code(() => verifyToken(SECRET, sign('string'), now))).toBe('INVALID');
  });

  it('rejects a non-canonical encoding of a valid signature', () => {
    const [v, p, s] = good().split('.');
    // appending padding changes the string but not the decoded bytes
    expect(code(() => verifyToken(SECRET, `${v}.${p}.${s}=`, now))).toBe('INVALID');
  });
});

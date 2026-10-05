import { createHmac, timingSafeEqual } from 'node:crypto';
import { UUID_RE } from './validation';

// QR token format:  v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256 of "v1.<payload>")>
//
// The payload holds ONLY the ticket id, the event id and an expiry time. It carries no name, email,
// user id or any other personal data, so a photographed QR code reveals nothing about the buyer.
// Whether a ticket is still valid is decided by the database at scan time, not by the token.
export interface QrPayload {
  tid: string; // ticket id
  eid: string; // event id
  exp: number; // expiry, seconds since epoch
}

export class QrError extends Error {
  constructor(
    public code: 'INVALID' | 'EXPIRED',
    message: string,
  ) {
    super(message);
  }
}

const VERSION = 'v1';
const MAX_TOKEN_LENGTH = 400;

const b64u = (b: Buffer): string => b.toString('base64url');
const mac = (secret: string, data: string): Buffer => createHmac('sha256', secret).update(data).digest();

export function signToken(secret: string, payload: QrPayload): string {
  const body = `${VERSION}.${b64u(Buffer.from(JSON.stringify({ tid: payload.tid, eid: payload.eid, exp: payload.exp })))}`;
  return `${body}.${b64u(mac(secret, body))}`;
}

// Verifies signature first, then structure, then expiry. Any structural problem is INVALID so a
// caller cannot learn anything about how a token was rejected beyond "bad" or "expired".
export function verifyToken(secret: string, token: unknown, nowSeconds = Math.floor(Date.now() / 1000)): QrPayload {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new QrError('INVALID', 'Invalid QR token');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) throw new QrError('INVALID', 'Invalid QR token');
  const [version, payloadPart, sigPart] = parts as [string, string, string];

  const expected = mac(secret, `${version}.${payloadPart}`);
  const given = Buffer.from(sigPart, 'base64url');
  // Constant-time comparison. The re-encode check rejects non-canonical base64 variants.
  if (given.length !== expected.length || !timingSafeEqual(given, expected) || b64u(given) !== sigPart) {
    throw new QrError('INVALID', 'Invalid QR token');
  }

  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw new QrError('INVALID', 'Invalid QR token');
  }
  const p = data as Partial<QrPayload> | null;
  if (
    !p || typeof p.tid !== 'string' || typeof p.eid !== 'string' || typeof p.exp !== 'number' ||
    !UUID_RE.test(p.tid) || !UUID_RE.test(p.eid) || !Number.isFinite(p.exp)
  ) {
    throw new QrError('INVALID', 'Invalid QR token');
  }
  if (p.exp <= nowSeconds) throw new QrError('EXPIRED', 'QR token has expired');
  return { tid: p.tid, eid: p.eid, exp: p.exp };
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { unauthorized } from './errors.js';

/* Why tokens exist at all: in v3 the stream URLs took no credential, so anyone who learned
 * an infohash could pull bytes against a 100 GB/month cap. But the player is a <video
 * src="…">, which cannot set an Authorization header — so the credential has to survive
 * being a query parameter, which means it has to expire. Hence a signed, short-lived token
 * rather than the password itself.
 *
 * Signed with PASS as the HMAC key, so there is no second secret to manage and rotating
 * PASS invalidates every outstanding token. Payload is the expiry and nothing else: with
 * two users there is no subject to carry. */

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signature(payload) {
  return createHmac('sha256', config.PASS).update(payload).digest();
}

export function issueToken(now = Date.now()) {
  const expiresAt = now + config.SESSION_TTL_HOURS * 3600_000;
  const payload = b64u(String(expiresAt));
  return { token: `${payload}.${b64u(signature(payload))}`, expiresAt };
}

export function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 512) throw unauthorized('missing token');
  const dot = token.indexOf('.');
  if (dot < 1) throw unauthorized('malformed token');

  const payload = token.slice(0, dot);
  const supplied = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = signature(payload);
  // timingSafeEqual throws on a length mismatch, so the length is checked first and both
  // paths land on the same generic error.
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw unauthorized('bad token signature');
  }

  const expiresAt = Number(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!Number.isFinite(expiresAt)) throw unauthorized('malformed token');
  if (expiresAt <= now) throw unauthorized('token expired');
  return { expiresAt };
}

/** Constant-time password check, used once per session instead of once per request. */
export function checkPassword(supplied) {
  if (typeof supplied !== 'string') throw unauthorized();
  const a = Buffer.from(supplied);
  const b = Buffer.from(config.PASS);
  if (a.length !== b.length) throw unauthorized();
  if (!timingSafeEqual(a, b)) throw unauthorized();
}

/** Express middleware. Accepts `Authorization: Bearer …` or `?t=…` for <video src>. */
export function requireToken(req, res, next) {
  const header = req.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  verifyToken(bearer ?? req.query.t);
  next();
}

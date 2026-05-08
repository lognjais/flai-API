import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { unauthorized } from './errors.js';

export function checkPassword(supplied) {
  if (typeof supplied !== 'string') throw unauthorized();
  const a = Buffer.from(supplied);
  const b = Buffer.from(config.PASS);
  if (a.length !== b.length) throw unauthorized();
  if (!timingSafeEqual(a, b)) throw unauthorized();
}

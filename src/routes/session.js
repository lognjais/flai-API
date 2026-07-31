import { Router } from 'express';
import { z } from 'zod';
import { checkPassword, issueToken } from '../lib/token.js';
import { badRequest } from '../lib/errors.js';

const Body = z.object({ password: z.string().min(1).max(256) });

export function sessionRouter() {
  const router = Router();

  // POST /session — trade the shared password for a short-lived token.
  router.post('/', (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw badRequest('expected { password }');
    checkPassword(parsed.data.password);
    res.json(issueToken());
  });

  return router;
}

import { Router } from 'express';
import { z } from 'zod';
import { checkPassword } from '../lib/auth.js';
import { makeid } from '../lib/makeid.js';
import { getDb } from '../db.js';
import { badRequest, notFound, upstream } from '../lib/errors.js';
import { logger } from '../logger.js';

const Body = z.object({
  url: z.string().url().max(8192),
  password: z.string().min(1).max(256),
});

const Params = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{8,32}$/, 'invalid id'),
});

async function fetchUpstream(targetUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(targetUrl, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export function linksRouter() {
  const router = Router();

  // POST /shorten — replaces the old /download form-redirect with a clean JSON API
  router.post('/shorten', async (req, res, next) => {
    try {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) throw badRequest('invalid body — expected { url, password }');
      checkPassword(parsed.data.password);

      const db = getDb();
      const collection = db.collection('flai');
      const existing = await collection.findOne({ url: parsed.data.url });
      if (existing) return res.json({ id: existing.link, url: parsed.data.url });

      const id = makeid(10);
      await collection.insertOne({ link: id, url: parsed.data.url, date: new Date().toISOString() });
      res.status(201).json({ id, url: parsed.data.url });
    } catch (err) {
      next(err);
    }
  });

  // GET /links/:id — proxy download (preserves original behavior)
  router.get('/links/:id', async (req, res, next) => {
    try {
      const parsed = Params.safeParse(req.params);
      if (!parsed.success) throw badRequest('invalid id');

      const db = getDb();
      const doc = await db.collection('flai').findOne({ link: parsed.data.id });
      if (!doc?.url) throw notFound('link not found');

      let upstreamRes;
      try {
        upstreamRes = await fetchUpstream(doc.url);
      } catch (err) {
        logger.warn({ err: err.message, id: parsed.data.id }, 'upstream fetch failed');
        throw upstream('source unreachable');
      }

      res.status(200);
      const ct = upstreamRes.headers.get('content-type');
      const cl = upstreamRes.headers.get('content-length');
      if (ct) res.setHeader('Content-Type', ct);
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Cache-Control', 'no-store');

      const reader = upstreamRes.body.getReader();
      res.on('close', () => reader.cancel().catch(() => {}));
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    } catch (err) {
      next(err);
    }
  });

  // GET /play/:id — same as /links/:id but always inline (no attachment)
  router.get('/play/:id', async (req, res, next) => {
    try {
      const parsed = Params.safeParse(req.params);
      if (!parsed.success) throw badRequest('invalid id');

      const db = getDb();
      const doc = await db.collection('flai').findOne({ link: parsed.data.id });
      if (!doc?.url) throw notFound('link not found');

      let upstreamRes;
      try {
        upstreamRes = await fetchUpstream(doc.url);
      } catch (err) {
        throw upstream('source unreachable');
      }

      res.status(200);
      const ct = upstreamRes.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      const cl = upstreamRes.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Cache-Control', 'no-store');

      const reader = upstreamRes.body.getReader();
      res.on('close', () => reader.cancel().catch(() => {}));
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

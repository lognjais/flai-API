import { Router } from 'express';

export function healthRouter(engine, startedAt) {
  const router = Router();

  /* Unauthenticated on purpose: Render's health check cannot carry a token. It exposes no
   * magnets and no filenames — only counts, speeds and the window's own bookkeeping.
   * bytesServed resets on restart. That is not sloppiness, it is the cost of holding no
   * state: a real monthly total would need storage, and storage is what v4 deleted. Render's
   * own dashboard is the authority on the 100 GB/month cap. */
  router.get('/', (req, res) => {
    res.json({
      ok: true,
      service: 'flai-api',
      version: '4.0.0',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      engine: engine.stats(),
    });
  });

  return router;
}

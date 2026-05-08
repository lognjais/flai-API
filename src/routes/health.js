import { Router } from 'express';

export function healthRouter(engine, startedAt) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({
      ok: true,
      service: 'flai-api',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      engine: engine.stats(),
    });
  });

  return router;
}

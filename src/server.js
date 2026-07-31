import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';

import { config, isProd } from './config.js';
import { logger } from './logger.js';
import { TorrentEngine } from './engine/index.js';
import { HttpError } from './lib/errors.js';
import { requireToken } from './lib/token.js';

import { sessionRouter } from './routes/session.js';
import { metadataRouter } from './routes/metadata.js';
import { streamRouter } from './routes/stream.js';
import { statsRouter } from './routes/stats.js';
import { healthRouter } from './routes/health.js';

async function bootstrap() {
  const startedAt = Date.now();

  const engine = new TorrentEngine();
  await engine.ready();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));
  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } })
  );
  /* Compression only helps /metadata on a large multi-file torrent — torrent payloads are
   * already compressed, and gzipping a 32 MB video slice would burn the 0.1 vCPU this box
   * has for nothing. */
  app.use(compression({ filter: (req, res) => /^application\/json/.test(String(res.getHeader('Content-Type'))) }));
  app.use(express.json({ limit: '64kb' }));

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // curl, server-to-server
        if (config.ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error(`origin ${origin} not allowed`));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', 'Range', 'Authorization'],
      exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Disposition'],
      maxAge: 86400,
    })
  );

  /* Two limiters. /session is the one worth grinding, so it is tight. /metadata is cheap to
   * ask for and expensive to serve, so it is moderate. Streaming is not limited at all: a
   * 4 GB download is ~500 legitimate chunk requests, and a limiter there would break the
   * exact thing v4 exists to fix. */
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'too many sign-in attempts' } },
  });
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'too many requests' } },
  });

  app.get('/', (req, res) => {
    res.json({
      service: 'flai-api',
      version: '4.0.0',
      docs: 'https://github.com/jvoltci/flai-api',
      routes: [
        'POST /session',
        'POST /metadata',
        'GET /torrent/:hash/:idx',
        'GET /stats/:hash',
        'GET /healthz',
      ],
    });
  });

  app.use('/healthz', healthRouter(engine, startedAt));
  app.use('/session', authLimiter, sessionRouter());
  app.use('/metadata', writeLimiter, requireToken, metadataRouter(engine));
  app.use('/torrent', requireToken, streamRouter(engine));
  app.use('/stats', requireToken, statsRouter(engine));

  app.use((req, res) => {
    res
      .status(404)
      .json({ error: { code: 'not_found', message: `no route for ${req.method} ${req.path}` } });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: { code: 'bad_request', message: err.message } });
    }
    if (/origin .* not allowed/.test(err?.message || '')) {
      return res.status(403).json({ error: { code: 'forbidden', message: err.message } });
    }
    req.log?.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res
      .status(500)
      .json({ error: { code: 'internal', message: isProd ? 'internal error' : err.message } });
  });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'flai-api listening');
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');
    server.close(() => logger.info('http closed'));
    await engine.destroy();
    setTimeout(() => process.exit(0), 100).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught — exiting');
    shutdown('uncaughtException');
  });
}

bootstrap().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'bootstrap failed');
  process.exit(1);
});

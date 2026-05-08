import pino from 'pino';
import { createRequire } from 'node:module';
import { config, isProd } from './config.js';

const require = createRequire(import.meta.url);

function tryLoadPretty() {
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, singleLine: true } };
  } catch {
    return null;
  }
}

const transport = !isProd ? tryLoadPretty() : null;

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'flai-api' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.user.password'],
    censor: '[REDACTED]',
  },
  ...(transport ? { transport } : {}),
});

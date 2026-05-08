import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Render free dynos sleep after 15 minutes of inactivity. Pinging ourselves at
 * a sub-15-minute cadence keeps the dyno warm — and our in-memory torrent
 * cache alive — at the cost of free-tier hours. Disabled if PUBLIC_URL is unset.
 */
export function startKeepWarm() {
  if (!config.PUBLIC_URL) {
    logger.info('keep-warm disabled (set PUBLIC_URL to enable)');
    return () => {};
  }
  const url = new URL('/healthz', config.PUBLIC_URL).toString();
  const tick = async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      logger.debug({ status: r.status, url }, 'keep-warm ping');
    } catch (err) {
      logger.warn({ err: err.message, url }, 'keep-warm ping failed');
    }
  };
  const handle = setInterval(tick, config.KEEP_WARM_INTERVAL_MS);
  handle.unref?.();
  logger.info({ url, intervalMs: config.KEEP_WARM_INTERVAL_MS }, 'keep-warm enabled');
  return () => clearInterval(handle);
}

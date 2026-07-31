import { z } from 'zod';

const MB = 1024 * 1024;

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /* The one secret. Session tokens are HMAC'd with it, so rotating PASS invalidates every
   * outstanding token — which is the whole password-rotation story for a two-user app. */
  PASS: z.string().min(1, 'PASS env var is required'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(168).default(12),

  ALLOWED_ORIGINS: z
    .string()
    .default('https://jvoltci.github.io,https://flai.ivehement.com,http://localhost:5173')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  /* ── the three numbers that keep this inside 512 MB ─────────────────────────
   *
   * Measured, not estimated: an idle v4 process is ~115 MB RSS (Node plus a started
   * webtorrent client), and each active torrent adds roughly 80 MB of peer-connection and
   * protocol buffers on top of its window. So:
   *
   *   115 + 2 x (64 window + 80 peers) = ~403 MB of a 512 MB box
   *
   * Two torrents is the honest ceiling. v3 shipped a default of 8, with no window at all,
   * and OOM'd.
   *
   * MAX_CHUNK_BYTES is the real bound, not the store. webtorrent's FileIterator takes a
   * stream selection over exactly the pieces a createReadStream covers and drops it when the
   * stream closes, so clamping every Range response means the engine can never want more
   * than one chunk of pieces at a time. The store budget is 4x the chunk: headroom for
   * pieces still arriving for the previous chunk, not the mechanism. At 16 MB a 4.6 GB file
   * is ~290 requests, which is nothing. */
  MAX_ACTIVE_TORRENTS: z.coerce.number().int().positive().default(2),
  MAX_CHUNK_BYTES: z.coerce.number().int().positive().default(16 * MB),
  WINDOW_BUDGET_BYTES: z.coerce.number().int().positive().default(64 * MB),

  MAX_CONNS: z.coerce.number().int().positive().default(30),
  METADATA_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  TORRENT_IDLE_EVICT_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] invalid environment:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';

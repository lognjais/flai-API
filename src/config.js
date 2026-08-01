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
   * READ_WINDOW_BYTES is the real bound, not the store. webtorrent's FileIterator takes a
   * stream selection over exactly the pieces a createReadStream covers and drops it when the
   * stream closes, so reading a file as a sequence of 16 MB windows means the engine can never
   * want more than 16 MB of pieces at a time — however large the file, and whatever the client
   * asked for. The store budget is 4x the window: headroom for pieces still arriving for the
   * previous window, not the mechanism.
   *
   * This is invisible from outside. Responses are ordinary and full-length, so a plain
   * <a download> works and Chrome's download manager can resume with Range. */
  MAX_ACTIVE_TORRENTS: z.coerce.number().int().positive().default(2),
  READ_WINDOW_BYTES: z.coerce.number().int().positive().default(16 * MB),
  /* 2x the read window, not 4x. The store is a cache, so it fills to whatever budget it is
   * given: measured over a full 129 MB download, a 64 MB budget sat at 67 MB resident and
   * peaked at 233 MB RSS, which is too much of a 512 MB box to spend twice. Only the current
   * window plus slack for pieces still arriving is ever needed. */
  WINDOW_BUDGET_BYTES: z.coerce.number().int().positive().default(32 * MB),

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

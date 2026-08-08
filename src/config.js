import { z } from 'zod';

const MB = 1024 * 1024;

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /* The one secret. Session tokens are HMAC'd with it, so rotating PASS invalidates every
   * outstanding token — which is the whole password-rotation story for a two-user app. */
  PASS: z.string().min(1, 'PASS env var is required'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(168).default(12),

  /* Just the one page. flai.ivehement.com was in here and has never resolved, and a stale
   * entry in an allowlist is the kind of thing nobody removes later.
   *
   * Worth being clear about what this does and does not buy, because it is easy to mistake
   * for a lock on the door. CORS is enforced by browsers, on behalf of *other* pages: it
   * stops someone else's site calling this API with your credentials. It stops nothing else.
   * curl sends no Origin at all, and anyone can send whatever Origin they like. The actual
   * credential is the HMAC token, and the actual protection against being flooded is the
   * connection and request limits in front of this process. */
  ALLOWED_ORIGINS: z
    .string()
    .default('https://jvoltci.github.io,http://localhost:5173')
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

  /* Peers per torrent, and the one number here that is about speed rather than safety.
   *
   * This was 30, lowered from v3's 80 to protect the box — below webtorrent's own default of
   * 55, which was a mistake. Peer acquisition, not the read path, is what makes a download feel
   * slow: a cold torrent spends its first minute crawling at tens of KB/s while DHT and the
   * trackers find peers, and more connection slots find them faster.
   *
   * Measured on one magnet, A-B-A so a warm DHT could not take the credit:
   *
   *   conns  metadata  first 8 MB  peak RSS   40 MB in
   *   30       8s         82s       177 MB      73s
   *   100      4s         47s       192 MB      39s
   *   30       8s         86s         —         —      (reverted, so the effect is real)
   *   200      —           —        185 MB      45s     (no further gain; peers plateau)
   *
   * So 100 buys roughly half the time-to-first-bytes for about 15 MB. Two torrents streaming at
   * once lands near 270 MB of 512 MB, which leaves room. 200 was not better — the swarm runs
   * out of reachable peers before the slots run out, which is what you would expect on a host
   * with no inbound connections. */
  MAX_CONNS: z.coerce.number().int().positive().default(100),
  METADATA_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /* How long a new read waits for the previous one to let go of the same torrent. Unwinding is
   * a destroyed stream and a finally block, so it takes milliseconds; this is only generous
   * enough that a busy event loop cannot make a handover look like a refusal. */
  STREAM_HANDOVER_MS: z.coerce.number().int().positive().default(5_000),
  /* Two different silences, and they need very different patience.
   *
   * STREAM_STALL_MS is a read waiting on the *swarm*: no pieces yet. Legitimate, and slow —
   * the measurements below put first bytes at ~47s on a cold torrent, and that read deserves
   * to keep its slot.
   *
   * DRAIN_GRACE_MS is a read waiting on the *client* to take bytes it has already produced.
   * Nothing like the same thing. The response buffer is 16 KB, so any client that is still
   * there clears it in well under a second; a few seconds of silence means nobody is reading.
   * That is the ordinary state of a cancelled browser download, because the edge proxy keeps
   * its upstream connection pooled and just stops draining it — no FIN, no 'close'. Past this,
   * a new request may take the window.
   *
   * DRAIN_TIMEOUT_MS is when such a read gives up unasked, so a phantom clears itself even if
   * nobody else ever wants the torrent.
   *
   * DRAIN_GRACE_MS was 3s, and running the suite on the 1/8 OCPU box this now deploys to showed
   * that is too tight. A setInterval on a heavily shared vCPU can slip by hundreds of
   * milliseconds, and every millisecond of slip looks exactly like a client that stopped
   * reading. Getting this wrong is asymmetric: too long and a phantom hangs about a few extra
   * seconds, too short and a download in progress gets its window taken. 8s. */
  STREAM_STALL_MS: z.coerce.number().int().positive().default(120_000),
  DRAIN_GRACE_MS: z.coerce.number().int().positive().default(8_000),
  DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
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

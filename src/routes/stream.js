import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { contentTypeFor, parseMagnet } from '../lib/magnet.js';
import { resolveRange } from '../lib/range.js';
import { contentDisposition } from '../lib/filename.js';
import { windows } from '../lib/windowed.js';
import { badRequest, conflict, notFound, rangeNotSatisfiable } from '../lib/errors.js';

const HEX40 = /^[a-f0-9]{40}$/i;

/* Waits for the response to accept more bytes, and gives up if nobody is reading it any more.
 *
 * The timeout is the whole point. `once(res, 'drain')` waits on an event that a socket nobody
 * is reading will never emit, and that one await is what left a cancelled download holding the
 * torrent until the process restarted. */
function waitForDrain(res, timeoutMs) {
  return new Promise((resolve, reject) => {
    const settle = (err) => {
      clearTimeout(timer);
      res.off('drain', ok);
      res.off('close', gone);
      if (err) reject(err);
      else resolve();
    };
    const ok = () => settle();
    const gone = () => settle(new Error('the client went away'));
    const timer = setTimeout(() => settle(new Error('the client stopped reading')), timeoutMs);
    timer.unref?.();
    res.once('drain', ok);
    res.once('close', gone);
  });
}

function findFile(torrent, key) {
  const index = Number(key);
  if (Number.isInteger(index) && index >= 0 && index < torrent.files.length) {
    return torrent.files[index];
  }
  return torrent.files.find((f) => f.name === key) ?? null;
}

export function streamRouter(engine) {
  const router = Router();

  /* GET /torrent/:infoHash/:fileKey?t=…&m=<magnet>&dl=1
   *
   * One ordinary HTTP response for the whole file, so a plain <a download> works and Chrome's
   * own download manager handles it — including resuming an interrupted download with
   * `Range: bytes=N-`, which is why Accept-Ranges and a stable ETag are set.
   *
   * The memory bound lives inside the loop below, not in the protocol. v4.0 clamped every
   * response to 16 MB and made the browser stitch the slices back together in a service
   * worker. It bounded memory correctly and it was the wrong design: it needed a service
   * worker to download a file, and when that did not work there was nothing to fall back to.
   */
  router.get('/:infoHash/:fileKey', async (req, res) => {
    const infoHash = req.params.infoHash.toLowerCase();
    if (!HEX40.test(infoHash)) throw badRequest('invalid infohash');

    let torrent = engine.get(infoHash);

    /* The URL carries its own magnet, so it can heal itself. The service holds no state, so a
     * spin-down, a redeploy or a capacity eviction leaves it with no way to find this torrent
     * again — but the link the browser is retrying has everything needed to re-add it. That is
     * what makes Chrome's native download resume survive a server restart with no client-side
     * code at all. */
    if (!torrent && typeof req.query.m === 'string') {
      const magnet = parseMagnet(req.query.m);
      if (magnet && magnet.infoHash === infoHash) {
        logger.info({ infoHash }, 're-adding torrent from the download URL');
        try {
          torrent = await engine.addOrGet(magnet);
        } catch (err) {
          logger.warn({ err: err.message, infoHash }, 're-add failed');
        }
      }
    }

    if (!torrent) {
      throw conflict('torrent not active — POST /metadata with the magnet, then retry', 'not_active');
    }

    const file = findFile(torrent, decodeURIComponent(req.params.fileKey));
    if (!file) throw notFound('file not found in torrent');

    const total = file.length;
    const { status, start, end } = resolveRange(req.headers.range, total);
    if (status === 416) {
      res.set('Accept-Ranges', 'bytes');
      throw rangeNotSatisfiable('that byte range is outside the file', 'range_not_satisfiable');
    }

    const expected = end - start + 1;
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentTypeFor(file.name),
      'Content-Length': expected,
      // Chrome sends this back as If-Range when resuming a download; without it the resume is
      // refused and the whole file starts over.
      ETag: `"${infoHash}-${file.length}-${req.params.fileKey}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    // Not encodeURIComponent — see lib/filename.js. It leaves apostrophes alone, which breaks
    // RFC 8187 parsing and made every episode of a series download as a file called "0".
    if (req.query.dl === '1') headers['Content-Disposition'] = contentDisposition(file.name);

    /* One sliding window per torrent, so one reader per torrent — but a read nobody is using
     * can be taken from it.
     *
     * This used to refuse every newcomer outright, which was the wrong half of the problem: a
     * cancelled read looks exactly like a healthy one from here, so cancelling a download and
     * starting another answered "busy" for the rest of the process's life. See
     * engine/reader-lock.js for what separates the two. Last thing before the read starts, so a
     * request that is about to 404 or 416 never disturbs whoever holds it. */
    if (engine.streamCount(infoHash) > 0) {
      if (!(await engine.takeOver(infoHash))) {
        throw conflict(
          'another file from this torrent is downloading — it frees up when that one finishes',
          'busy'
        );
      }
      logger.info({ infoHash }, 'took the read over from an earlier request');
    }

    /* A dry run of everything above, for the page to call before it starts a download.
     *
     * Once a URL is handed to the browser's download manager the page gets no say in it: a 409
     * is not an error the user sees, it is a 120-byte JSON file saved under the name of the
     * episode they wanted. Asking first is the only way to put that answer on the page. Costs
     * one round trip and touches no pieces. */
    if (req.query.probe === '1') return res.status(204).end();

    /* Ending this read early is harder than it looks, and getting it wrong is what made a
     * cancelled download block the torrent for good.
     *
     * res 'close' is the obvious signal and it is not enough. It fires for curl, which is why
     * the first attempt at this measured as fixed from the command line and changed nothing for
     * a browser. Cancelling a browser download resets the HTTP/2 stream to the edge proxy; the
     * proxy keeps its upstream HTTP/1.1 connection pooled and simply stops reading it. No FIN,
     * no 'close' — just a socket that has quietly stopped accepting bytes. So the read also
     * has to notice that for itself, below. */
    const stop = new AbortController();
    res.on('close', () => stop.abort(new Error('client went away')));

    let written = 0;
    let lastProgress = Date.now();
    let parkedSince = null;

    const release = engine.trackStream(torrent, {
      abort: () => stop.abort(new Error('read handed over')),
      healthy: () => {
        if (stop.signal.aborted || res.destroyed) return false;
        /* Parked waiting for the client to take more bytes. A live client clears this in well
         * under a second whatever its speed, because the response buffer is 16 KB — so a few
         * seconds of it means nobody is on the other end. */
        if (parkedSince !== null) return Date.now() - parkedSince < config.DRAIN_GRACE_MS;
        // Waiting on the swarm instead, which is legitimate and slow on a cold torrent.
        return Date.now() - lastProgress < config.STREAM_STALL_MS;
      },
    });

    /* One rejection for the whole read, raced against every wait below.
     *
     * It has to be one, not one per wait: a 1 GB episode is ~16,000 chunks, and an abort
     * listener per chunk is a listener leak. */
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(stop.signal.reason);
      if (stop.signal.aborted) fail();
      else stop.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => {}); // raced repeatedly, so it must never look unhandled

    const reader = windows(file, config.READ_WINDOW_BYTES, start, end, stop.signal);
    try {
      res.writeHead(status, headers);
      /* The bound — see lib/windowed.js. Backpressure does the rest: if the client reads
       * slowly, the drain below blocks here and the swarm is never asked to run ahead of what
       * is actually being consumed.
       *
       * Not `for await`, because the read has to be able to give up on the generator. Peers go
       * quiet and a window can stall indefinitely, and webtorrent's file streams are streamx
       * rather than node streams: destroying a stalled streamx Readable does not reject an
       * in-flight iteration — measured, it stays parked for ever. Destroying it still drops the
       * piece selection, which is the part that costs memory; racing here is what lets the
       * route stop waiting for it. */
      for (;;) {
        const next = await Promise.race([reader.next(), aborted]);
        if (next.done) break;
        written += next.value.length;
        if (!res.write(next.value)) {
          parkedSince = Date.now();
          try {
            await Promise.race([waitForDrain(res, config.DRAIN_TIMEOUT_MS), aborted]);
          } finally {
            parkedSince = null;
          }
        }
        lastProgress = Date.now();
      }
      res.end();
    } catch (err) {
      // A cancelled download, or a read handed to someone else. Neither is a fault.
      if (stop.signal.aborted || res.destroyed) {
        logger.debug({ infoHash, file: file.name, written }, 'read ended early');
      } else {
        logger.warn({ err: err.message, infoHash, file: file.name, written }, 'stream error');
      }
      if (!res.destroyed) res.destroy();
    } finally {
      // Never awaited: if the generator is parked on a stalled streamx read, this never settles.
      reader.return().catch(() => {});
      release(written);
    }

    /* A short body on a response we ended ourselves means the store had forgotten a piece the
     * bitfield still claims. webtorrent never re-requests a piece it believes it has, so the
     * only cure is to start the torrent over; Chrome then resumes with Range and it works. */
    if (written < expected && res.writableEnded) {
      logger.warn({ infoHash, file: file.name, written, expected }, 'short read — resetting');
      engine.reset(infoHash).catch((err) => logger.warn({ err: err.message }, 'reset failed'));
    }
  });

  return router;
}

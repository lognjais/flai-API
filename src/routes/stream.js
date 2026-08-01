import { Router } from 'express';
import { once } from 'node:events';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { contentTypeFor, parseMagnet } from '../lib/magnet.js';
import { resolveRange } from '../lib/range.js';
import { contentDisposition } from '../lib/filename.js';
import { windows } from '../lib/windowed.js';
import { badRequest, conflict, notFound, rangeNotSatisfiable } from '../lib/errors.js';

const HEX40 = /^[a-f0-9]{40}$/i;

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

    /* Two ways this read ends early, and both must actually unblock it.
     *
     * The bug: a client that goes away mid-transfer left `await once(res, 'drain')` parked on
     * an event that could never fire, because the socket it would have come from was gone. The
     * read was never released, so the torrent could never be evicted and every later request
     * for it answered "busy" — for the life of the process. Wiring 'close' to the signal is the
     * fix; everything else here just makes the same signal serve the handover too. */
    const stop = new AbortController();
    res.on('close', () => stop.abort(new Error('client went away')));

    let written = 0;
    let lastProgress = Date.now();
    const release = engine.trackStream(torrent, {
      abort: () => stop.abort(new Error('read handed over')),
      /* What separates a download in progress from a socket nobody is on the other end of.
       * A live client drains many times a second however slow its connection, because the
       * response buffer is 16 KB; only a dead one stops entirely. */
      healthy: () =>
        !stop.signal.aborted &&
        !res.destroyed &&
        Date.now() - lastProgress < config.STREAM_STALL_MS,
    });

    try {
      res.writeHead(status, headers);
      /* The bound — see lib/windowed.js. Backpressure does the rest: if the client reads slowly,
       * res.write() blocks here and the swarm is never asked to run ahead of what is actually
       * being consumed. */
      for await (const chunk of windows(file, config.READ_WINDOW_BYTES, start, end, stop.signal)) {
        written += chunk.length;
        lastProgress = Date.now();
        if (!res.write(chunk)) await once(res, 'drain', { signal: stop.signal });
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

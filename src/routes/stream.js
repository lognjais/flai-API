import { Router } from 'express';
import { once } from 'node:events';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { contentTypeFor, parseMagnet } from '../lib/magnet.js';
import { resolveRange } from '../lib/range.js';
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

    /* One sliding window per torrent, so one reader per torrent. Two readers at different
     * offsets would evict each other's pieces and both would crawl. */
    if (engine.streamCount(infoHash) > 0) {
      throw conflict('another read is already open on this torrent', 'busy');
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
    if (req.query.dl === '1') {
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`;
    }

    const release = engine.trackStream(torrent);
    res.writeHead(status, headers);

    let written = 0;
    try {
      /* The bound, shared with the zip route — see lib/windowed.js. Backpressure does the rest:
       * if the client reads slowly, res.write() blocks here and the swarm is never asked to run
       * ahead of what is actually being consumed. */
      for await (const chunk of windows(file, config.READ_WINDOW_BYTES, start, end)) {
        if (res.destroyed) return;
        written += chunk.length;
        if (!res.write(chunk)) await once(res, 'drain');
      }
      res.end();
    } catch (err) {
      // A client closing the tab mid-download is normal, not a fault.
      if (!res.destroyed) {
        logger.warn({ err: err.message, infoHash, file: file.name, written }, 'stream error');
        res.destroy();
      }
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

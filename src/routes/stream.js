import { Router } from 'express';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { contentTypeFor } from '../lib/magnet.js';
import { resolveRange } from '../lib/range.js';
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

  // GET /torrent/:infoHash/:fileKey — one bounded slice of one file.
  router.get('/:infoHash/:fileKey', async (req, res) => {
    const infoHash = req.params.infoHash.toLowerCase();
    if (!HEX40.test(infoHash)) throw badRequest('invalid infohash');

    const torrent = engine.get(infoHash);
    /* Not an error — the contract. The server keeps no magnets, so it cannot resurrect a
     * torrent that a spin-down or an eviction took away. The client holds the magnet and
     * re-posts /metadata on this code, then retries. */
    if (!torrent) {
      throw conflict('torrent not active — POST /metadata with the magnet, then retry', 'not_active');
    }

    /* One window per torrent, so one reader per torrent. Two readers at different offsets
     * would evict each other's pieces and both would crawl. */
    if (engine.streamCount(infoHash) > 0) {
      throw conflict('another read is already open on this torrent', 'busy');
    }

    const file = findFile(torrent, decodeURIComponent(req.params.fileKey));
    if (!file) throw notFound('file not found in torrent');

    const total = file.length;
    const { status, start, end } = resolveRange(req.headers.range, total, config.MAX_CHUNK_BYTES);
    if (status === 416) {
      res.set('Accept-Ranges', 'bytes');
      throw rangeNotSatisfiable(
        `send a Range header of at most ${config.MAX_CHUNK_BYTES} bytes — this bridge streams in slices, never whole files`
      );
    }

    const expected = end - start + 1;
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentTypeFor(file.name),
      'Content-Length': expected,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    if (req.query.dl === '1') {
      headers['Content-Disposition'] =
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`;
    }

    const release = engine.trackStream(torrent);
    let written = 0;
    // Counting in a Transform rather than on a 'data' listener: attaching a listener to a
    // stream that is also being piped puts two consumers on the same source.
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        cb(null, chunk);
      },
    });

    res.writeHead(status, headers);
    try {
      await pipeline(file.createReadStream({ start, end }), counter, res);
    } catch (err) {
      // A client that closes the tab mid-chunk is normal, not a fault.
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.warn({ err: err.message, infoHash, file: file.name }, 'stream error');
      }
    } finally {
      release(written);
    }

    /* A short body on a response we ended ourselves means the store had forgotten a piece the
     * bitfield still claims — a seek behind the window, or a second pass over a file the
     * window has moved past. webtorrent never re-requests a piece it believes it has, so the
     * only cure is to start the torrent over; the client's retry then succeeds. A client
     * abort looks different: the socket dies before we end, so writableEnded stays false. */
    if (written < expected && res.writableEnded) {
      logger.warn({ infoHash, file: file.name, written, expected }, 'short read — window passed');
      engine.reset(infoHash).catch((err) => logger.warn({ err: err.message }, 'reset failed'));
    }
  });

  return router;
}

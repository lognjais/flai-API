import { Router } from 'express';
import { ZipArchive } from 'archiver';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseMagnet } from '../lib/magnet.js';
import { windowedStream } from '../lib/windowed.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const HEX40 = /^[a-f0-9]{40}$/i;

export function archiveRouter(engine) {
  const router = Router();

  /* GET /torrent/:infoHash?dl=1&t=…&m=<magnet> — every file, as one zip.
   *
   * v4 deleted this route because the obvious implementation appends a createReadStream per
   * file up front, which selects every piece of every file at once. It is back because
   * windowedStream is an async generator: archiver consumes them one at a time, and an
   * unconsumed generator has opened nothing. Peak memory is the same one window as a
   * single-file download, whether the torrent holds one file or three hundred.
   *
   * Stored, not deflated. Torrent payloads are already compressed, and this box has a tenth of
   * a vCPU — deflate would spend all of it to make the file very slightly larger. */
  router.get('/:infoHash', async (req, res) => {
    const infoHash = req.params.infoHash.toLowerCase();
    if (!HEX40.test(infoHash)) throw badRequest('invalid infohash');

    let torrent = engine.get(infoHash);

    // Same self-healing contract as the single-file route: the URL carries its own magnet.
    if (!torrent && typeof req.query.m === 'string') {
      const magnet = parseMagnet(req.query.m);
      if (magnet && magnet.infoHash === infoHash) {
        logger.info({ infoHash }, 're-adding torrent from the archive URL');
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
    if (engine.streamCount(infoHash) > 0) {
      throw conflict('another read is already open on this torrent', 'busy');
    }

    const files = torrent.files.filter((f) => f.length > 0);
    if (files.length === 0) throw notFound('this torrent has no files with any bytes in them');

    /* No Content-Length, and it cannot be helped. The archive is generated as it is sent, so
     * its length is not known when the headers go out — which means Chrome shows an unknown
     * size and, more importantly, cannot resume this one if it breaks. Single files keep both.
     * That is the trade for getting everything in one action, and the UI says so. */
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(torrent.name)}.zip`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    const release = engine.trackStream(torrent);
    // archiver 8 is ESM-native and has no default export — `new ZipArchive(opts)`, not
    // `archiver('zip', opts)`. The old call signature fails at import time, not at request
    // time, so it takes the whole service down rather than one route.
    const zip = new ZipArchive({ store: true });

    let written = 0;
    zip.on('data', (chunk) => {
      written += chunk.length;
    });
    zip.on('warning', (err) => logger.warn({ err: err.message, infoHash }, 'zip warning'));

    try {
      for (const file of files) {
        zip.append(windowedStream(file, config.READ_WINDOW_BYTES), {
          // file.path keeps the torrent's own folder structure inside the archive.
          name: file.path,
        });
      }
      zip.pipe(res);
      await zip.finalize();
      logger.info({ infoHash, files: files.length, written }, 'zip complete');
    } catch (err) {
      // A client closing the tab mid-archive is normal, not a fault.
      if (!res.destroyed) {
        logger.warn({ err: err.message, infoHash, written }, 'zip failed');
        res.destroy();
      }
    } finally {
      zip.destroy();
      release(written);
    }
  });

  return router;
}

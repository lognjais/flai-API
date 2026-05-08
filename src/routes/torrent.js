import { Router } from 'express';
import archiver from 'archiver';
import { logger } from '../logger.js';
import { contentTypeFor } from '../lib/magnet.js';
import { badRequest, notFound } from '../lib/errors.js';

function parseRange(header, totalSize) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];

  let start, end;
  if (startStr === '' && endStr !== '') {
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr ? parseInt(endStr, 10) : totalSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= totalSize) return null;
  if (end >= totalSize) end = totalSize - 1;
  return { start, end };
}

function findFileByIndexOrName(torrent, key) {
  const asIndex = Number(key);
  if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < torrent.files.length) {
    return torrent.files[asIndex];
  }
  return torrent.files.find((f) => f.name === key) ?? null;
}

export function torrentRouter(engine) {
  const router = Router();

  // GET /torrent/:infoHash/:fileKey  — single file, range-aware
  router.get('/:infoHash/:fileKey', (req, res, next) => {
    try {
      const { infoHash, fileKey } = req.params;
      if (!/^[a-f0-9]{40}$/i.test(infoHash)) throw badRequest('invalid infohash');

      const torrent = engine.get(infoHash.toLowerCase());
      if (!torrent || !torrent.ready) {
        throw notFound('torrent not active — POST /metadata first');
      }

      const file = findFileByIndexOrName(torrent, decodeURIComponent(fileKey));
      if (!file) throw notFound('file not found in torrent');

      const total = file.length;
      const contentType = contentTypeFor(file.name);
      const baseHeaders = {
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };

      const range = parseRange(req.headers.range, total);
      const release = engine.trackStream(torrent);

      let stream;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { stream?.destroy(); } catch {}
        release();
      };

      if (range) {
        const { start, end } = range;
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
        });
        stream = file.createReadStream({ start, end });
      } else {
        const isAttachment = req.query.dl === '1';
        res.writeHead(200, {
          ...baseHeaders,
          'Content-Length': total,
          ...(isAttachment ? { 'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"` } : {}),
        });
        stream = file.createReadStream();
      }

      stream.on('error', (err) => {
        logger.warn({ err: err.message, infoHash, file: file.name }, 'stream error');
        cleanup();
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });

      res.on('close', cleanup);
      res.on('finish', cleanup);
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // GET /torrent/:infoHash  — zip of all files
  router.get('/:infoHash', (req, res, next) => {
    try {
      const { infoHash } = req.params;
      if (!/^[a-f0-9]{40}$/i.test(infoHash)) throw badRequest('invalid infohash');

      const torrent = engine.get(infoHash.toLowerCase());
      if (!torrent || !torrent.ready) throw notFound('torrent not active — POST /metadata first');

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(torrent.name)}.zip"`,
        'Cache-Control': 'no-store',
      });

      const release = engine.trackStream(torrent);
      const zip = archiver('zip', { zlib: { level: 0 } });

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { zip.abort(); } catch {}
        release();
      };

      zip.on('error', (err) => {
        logger.warn({ err: err.message, infoHash }, 'zip error');
        cleanup();
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      res.on('close', cleanup);
      res.on('finish', cleanup);

      zip.pipe(res);
      for (const file of torrent.files) {
        zip.append(file.createReadStream(), { name: file.path });
      }
      zip.finalize();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

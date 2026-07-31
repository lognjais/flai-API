import { Router } from 'express';
import { z } from 'zod';
import { parseMagnet, contentTypeFor, isStreamable } from '../lib/magnet.js';
import { badRequest, timeout, upstream } from '../lib/errors.js';

const Body = z.object({ url: z.string().min(20).max(8192) });

export function metadataRouter(engine) {
  const router = Router();

  /* POST /metadata — the only route that takes a magnet, and the reason the server needs no
   * database. The client keeps the magnet in IndexedDB and re-posts it whenever a stream
   * answers 409 not_active, so a spin-down costs one silent round trip instead of a failure. */
  router.post('/', async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw badRequest('expected { url }');

    const magnet = parseMagnet(parsed.data.url);
    if (!magnet) throw badRequest('not a valid magnet URI (need xt=urn:btih:...)');

    let torrent;
    try {
      torrent = await engine.addOrGet(magnet);
    } catch (err) {
      if (/timed out/i.test(err.message)) throw timeout('peers were slow to respond — try again');
      throw upstream(`could not fetch torrent metadata: ${err.message}`);
    }

    res.json({
      infoHash: torrent.infoHash,
      name: torrent.name,
      size: torrent.length,
      pieceLength: torrent.pieceLength,
      files: torrent.files.map((f, i) => ({
        index: i,
        name: f.name,
        path: f.path,
        length: f.length,
        contentType: contentTypeFor(f.name),
        streamable: isStreamable(f.name),
      })),
    });
  });

  return router;
}

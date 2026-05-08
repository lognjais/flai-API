import { Router } from 'express';
import { z } from 'zod';
import { checkPassword } from '../lib/auth.js';
import { parseMagnet } from '../lib/magnet.js';
import { badRequest, timeout, upstream } from '../lib/errors.js';
import { contentTypeFor, isStreamable } from '../lib/magnet.js';

const Body = z.object({
  url: z.string().min(20).max(8192),
  password: z.string().min(1).max(256),
});

export function metadataRouter(engine) {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) throw badRequest('invalid body — expected { url, password }');
      checkPassword(parsed.data.password);

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
        files: torrent.files.map((f, i) => ({
          index: i,
          name: f.name,
          path: f.path,
          length: f.length,
          contentType: contentTypeFor(f.name),
          streamable: isStreamable(f.name),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

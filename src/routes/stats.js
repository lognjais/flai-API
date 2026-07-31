import { Router } from 'express';
import { badRequest } from '../lib/errors.js';

const HEX40 = /^[a-f0-9]{40}$/i;
const TICK_MS = 1000;

/* Server-sent events rather than polling, for two reasons. The obvious one is that the UI
 * wants peers and speed at 1 Hz and polling that is 60 requests a minute through the rate
 * limiter. The useful one is that an open SSE connection is inbound traffic, and Render's
 * free tier spins a service down after 15 minutes without any — so while a download is on
 * screen, the box cannot fall asleep underneath it. */
export function statsRouter(engine) {
  const router = Router();

  router.get('/:infoHash', (req, res) => {
    const infoHash = req.params.infoHash.toLowerCase();
    if (!HEX40.test(infoHash)) throw badRequest('invalid infohash');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Proxies that buffer would defeat the point.
      'X-Accel-Buffering': 'no',
    });

    const send = () => {
      const torrent = engine.get(infoHash);
      const payload = torrent
        ? {
            active: true,
            ready: torrent.ready,
            numPeers: torrent.numPeers,
            downloadSpeed: torrent.downloadSpeed,
            uploaded: torrent.uploaded,
            streams: engine.streamCount(infoHash),
          }
        : { active: false };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send();
    const timer = setInterval(send, TICK_MS);
    res.on('close', () => {
      clearInterval(timer);
      res.end();
    });
  });

  return router;
}

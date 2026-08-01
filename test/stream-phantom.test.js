import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';

/* A cancelled browser download, as the server actually sees it.
 *
 * stream-release.test.js hangs up with req.destroy(), which fires res 'close' and unwinds
 * everything. That is what curl does, and it is why the first fix measured as working from the
 * command line and did nothing for the reported bug.
 *
 * A browser behind a reverse proxy is different. Cancelling a download resets the HTTP/2 stream
 * to the edge; the edge keeps its upstream HTTP/1.1 connection in the pool and simply stops
 * reading it. The socket stays open, 'close' never fires, and the route is parked on a drain
 * that will never come — indistinguishable, from inside, from a client that has paused.
 *
 * Measured against production before this test existed: a torrent stuck at streams=1 with
 * downloadSpeed 0, and every later request answering 409 after 5.4s — exactly the handover
 * timeout, meaning the abort was reaching the reader and the reader was not unwinding. */

process.env.PASS ||= 'test-pass';
process.env.LOG_LEVEL = 'fatal';
process.env.READ_WINDOW_BYTES = String(1024 * 1024);

const [{ default: express }, { streamRouter }, { ReaderLock }, { HttpError }, { config }] =
  await Promise.all([
    import('express'),
    import('../src/routes/stream.js'),
    import('../src/engine/reader-lock.js'),
    import('../src/lib/errors.js'),
    import('../src/config.js'),
  ]);

const HASH = 'd'.repeat(40);
const SIZE = 64 * 1024 * 1024;

function harness() {
  const file = {
    name: 'ep01.mkv',
    length: SIZE,
    open: 0,
    createReadStream({ start = 0, end = SIZE - 1 } = {}) {
      file.open++;
      let at = start;
      const stream = new Readable({
        read() {
          if (at > end) return this.push(null);
          const size = Math.min(65536, end - at + 1);
          at += size;
          this.push(Buffer.alloc(size, 7));
        },
      });
      stream.on('close', () => { file.open--; });
      return stream;
    },
  };
  const torrent = { infoHash: HASH, ready: true, files: [file], file };
  const lock = new ReaderLock();
  const engine = {
    get: () => torrent,
    streamCount: (h) => lock.count(h),
    trackStream: (t, opts) => lock.acquire(t.infoHash, opts),
    takeOver: (h) => lock.takeOver(h, config.STREAM_HANDOVER_MS),
    reset: async () => {},
  };

  const app = express();
  app.use('/torrent', streamRouter(engine));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err instanceof HttpError ? err.status : 500;
    res.status(status).json({ error: { code: err.code ?? 'internal', message: err.message } });
  });

  const server = app.listen(0);
  return {
    engine,
    torrent,
    server,
    ready: once(server, 'listening'),
    stop: () => { server.closeAllConnections(); server.close(); },
  };
}

/** Reads `bytes`, then stops reading and holds the socket open. Nothing is destroyed. */
async function phantom(server, bytes = 512 * 1024) {
  const req = http.get({ port: server.address().port, path: `/torrent/${HASH}/0` });
  req.on('error', () => {});
  const [res] = await once(req, 'response');
  let got = 0;
  await new Promise((resolve) => {
    res.on('data', (chunk) => {
      got += chunk.length;
      if (got >= bytes) {
        res.pause();
        resolve();
      }
    });
  });
  return { req, res };
}

async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

const get = (server, path, headers) =>
  new Promise((resolve) => {
    const req = http.get({ port: server.address().port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => {});
  });

test('a reader whose client stopped reading can be taken over', async (t) => {
  const { engine, server, stop, ready } = harness();
  await ready;
  t.after(stop);
  config.DRAIN_GRACE_MS = 300;

  const held = await phantom(server);
  t.after(() => held.req.destroy());
  await waitFor(() => engine.streamCount(HASH) === 1, 2000, 'the phantom read to open');

  // Straight away it still looks like a slow client, and must be left alone.
  assert.equal(await get(server, `/torrent/${HASH}/0?probe=1`), 409, 'protected while it may be alive');

  // Once it has been silent past the grace, a newcomer takes it.
  await new Promise((r) => setTimeout(r, 500));
  const started = Date.now();
  assert.equal(await get(server, `/torrent/${HASH}/0?probe=1`), 204, 'the newcomer gets in');
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < config.STREAM_HANDOVER_MS,
    `handover completed rather than timing out (${elapsed}ms)`
  );
  await waitFor(() => engine.streamCount(HASH) === 0, 2000, 'the phantom to let go');
});

test('a phantom gives up on its own, with nobody else asking', async (t) => {
  const { engine, server, stop, ready } = harness();
  await ready;
  t.after(stop);
  config.DRAIN_TIMEOUT_MS = 400;

  const held = await phantom(server);
  t.after(() => held.req.destroy());
  await waitFor(() => engine.streamCount(HASH) === 1, 2000, 'the phantom read to open');
  await waitFor(() => engine.streamCount(HASH) === 0, 4000, 'it to time out by itself');
});

test('a genuinely slow client is not mistaken for a phantom', async (t) => {
  const { engine, server, stop, ready } = harness();
  await ready;
  t.after(stop);
  config.DRAIN_GRACE_MS = 300;
  config.DRAIN_TIMEOUT_MS = 60_000;

  // Reads in bursts with gaps shorter than the grace — slow, but alive.
  const req = http.get({ port: server.address().port, path: `/torrent/${HASH}/0` });
  req.on('error', () => {});
  const [res] = await once(req, 'response');
  res.pause();
  const pump = setInterval(() => res.read(65536), 50);
  t.after(() => { clearInterval(pump); req.destroy(); });

  await waitFor(() => engine.streamCount(HASH) === 1, 2000, 'the slow read to open');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(engine.streamCount(HASH), 1, 'still going');
  assert.equal(await get(server, `/torrent/${HASH}/0?probe=1`), 409, 'and still protected');
});

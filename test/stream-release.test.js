import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';

/* The bug this file exists for. Reported from real use: cancel a download, start another, and
 * every request for that torrent answers
 *
 *   { "error": { "code": "busy", "message": "another read is already open on this torrent" } }
 *
 * The read was never released. res.write() had returned false, the route parked on
 * `await once(res, 'drain')`, and the client went away — so 'drain' never fired and the await
 * never settled. The reader stayed on the books forever, and since idle eviction skips a
 * torrent that is being read, the torrent stayed pinned in one of only two slots too.
 *
 * A unit test cannot catch this: it only happens with a real socket that stops draining. So
 * this runs the real route over real HTTP and hangs up mid-transfer. */

process.env.PASS ||= 'test-pass';
process.env.LOG_LEVEL = 'fatal';
process.env.READ_WINDOW_BYTES = String(1024 * 1024);

// Dynamic, so the env above is set before config.js reads it.
const [{ default: express }, { streamRouter }, { ReaderLock }, { HttpError }, { config }] =
  await Promise.all([
    import('express'),
    import('../src/routes/stream.js'),
    import('../src/engine/reader-lock.js'),
    import('../src/lib/errors.js'),
    import('../src/config.js'),
  ]);

const collect = async (stream) => {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return parts;
};

const HASH = 'c'.repeat(40);
// Big enough that the server cannot possibly finish before the client hangs up.
const SIZE = 64 * 1024 * 1024;

function fakeTorrent() {
  const file = {
    name: "S01E01 - Long Day's Journey.mkv",
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
  return { infoHash: HASH, ready: true, files: [file], file };
}

/* Everything the route touches, backed by the real ReaderLock so the handover path is the
 * production one and not a test-shaped imitation of it. */
function harness({ stallMs } = {}) {
  if (stallMs !== undefined) config.STREAM_STALL_MS = stallMs;
  else config.STREAM_STALL_MS = 120_000;
  const torrent = fakeTorrent();
  const lock = new ReaderLock();
  const engine = {
    get: () => torrent,
    streamCount: (h) => lock.count(h),
    trackStream: (t, abort) => lock.acquire(t.infoHash, abort),
    takeOver: (h) => lock.takeOver(h, 2000),
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
  /* closeAllConnections, not just close: a wedged route holds its socket open, and without
   * this a failing run hangs at exit instead of reporting the failure. */
  const stop = () => { server.closeAllConnections(); server.close(); };
  return { engine, torrent, server, stop, ready: once(server, 'listening') };
}

/** Opens a download and reads nothing, so the server's socket buffer fills and write() blocks. */
function startDownload(server) {
  const req = http.get({ port: server.address().port, path: `/torrent/${HASH}/0` });
  req.on('error', () => { /* hanging up is the point */ });
  return req;
}

async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

test('a cancelled download releases the torrent', async (t) => {
  const { engine, torrent, server, stop, ready } = harness();
  await ready;
  t.after(stop);

  const req = startDownload(server);
  const [res] = await once(req, 'response');
  assert.equal(res.statusCode, 200);
  res.on('error', () => {});

  // Let it get properly wedged: buffers full, route parked waiting to drain.
  await waitFor(() => engine.streamCount(HASH) === 1, 2000, 'the read to open');
  await new Promise((r) => setTimeout(r, 300));

  req.destroy(); // the user cancels

  await waitFor(() => engine.streamCount(HASH) === 0, 3000, 'the read to be released');
  await waitFor(() => torrent.file.open === 0, 1000, 'the piece selection to be dropped');
});

test('and the next download of the same torrent just works', async (t) => {
  const { engine, server, stop, ready } = harness();
  await ready;
  t.after(stop);

  const first = startDownload(server);
  await once(first, 'response');
  await waitFor(() => engine.streamCount(HASH) === 1, 2000, 'the first read to open');
  await new Promise((r) => setTimeout(r, 200));
  first.destroy();
  await waitFor(() => engine.streamCount(HASH) === 0, 3000, 'the first read to be released');

  const second = startDownload(server);
  const [res] = await once(second, 'response');
  res.on('error', () => {});
  assert.equal(res.statusCode, 200, 'must not be 409 busy');
  second.destroy();
});

/* A client that vanishes without closing the socket — a slept laptop, a dropped wifi — looks
 * identical to a healthy reader from here, and the socket can sit for minutes before TCP gives
 * up. STREAM_STALL_MS=0 is that reader with the waiting already done. */
test('a new request takes the read over from a stalled one', async (t) => {
  const { engine, server, stop, ready } = harness({ stallMs: 0 });
  await ready;
  t.after(stop);

  const stuck = startDownload(server);
  await once(stuck, 'response');
  await waitFor(() => engine.streamCount(HASH) === 1, 2000, 'the first read to open');

  const newcomer = startDownload(server);
  const [res] = await once(newcomer, 'response');
  res.on('error', () => {});
  assert.equal(res.statusCode, 200, 'the newcomer wins');
  assert.equal(engine.streamCount(HASH), 1, 'and there is still exactly one reader');

  newcomer.destroy();
  stuck.destroy();
  await waitFor(() => engine.streamCount(HASH) === 0, 3000, 'both to be released');
});

/* The other half of the rule. A download in progress is not something a second request gets to
 * interrupt — otherwise two people pulling episodes from one torrent take the window from each
 * other in turn and neither finishes. */
test('a download in progress is not interrupted, it is refused', async (t) => {
  const { engine, server, stop, ready } = harness();
  await ready;
  t.after(stop);

  const live = startDownload(server);
  const [liveRes] = await once(live, 'response');
  liveRes.resume(); // actually reading, so the route keeps writing
  await waitFor(() => engine.streamCount(HASH) === 1, 2000, 'the live read to open');

  const newcomer = startDownload(server);
  const [res] = await once(newcomer, 'response');
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(Buffer.concat(await collect(res)).toString());
  assert.equal(body.error.code, 'busy');
  assert.match(body.error.message, /frees up when that one finishes/);

  assert.equal(engine.streamCount(HASH), 1, 'the live download still holds it');
  let bytes = 0;
  liveRes.on('data', (c) => { bytes += c.length; });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(bytes > 0, 'and is still being served');

  live.destroy();
  await waitFor(() => engine.streamCount(HASH) === 0, 3000, 'the live read to be released');
});

/* The question this whole design has to answer: A pauses, B downloads and finishes, A resumes.
 * A's resume is an ordinary Range request — it does not wait in a queue or hold anything while
 * paused, so by the time B is done the window is simply free. */
test('A pauses, B finishes, A resumes and gets the right bytes', async (t) => {
  const { engine, torrent, server, stop, ready } = harness();
  await ready;
  t.after(stop);
  const port = server.address().port;
  const END = 400_000;

  const get = (headers) =>
    new Promise((resolve) => {
      const req = http.get({ port, path: `/torrent/${HASH}/0`, headers }, (res) =>
        collect(res).then((parts) => resolve({ res, body: Buffer.concat(parts) }))
      );
      req.on('error', () => {});
    });

  // A starts, reads a little, pauses.
  const a = startDownload(server);
  const [aRes] = await once(a, 'response');
  let got = 0;
  aRes.on('data', (chunk) => { got += chunk.length; });
  await new Promise((r) => setTimeout(r, 150));
  a.destroy();
  await waitFor(() => engine.streamCount(HASH) === 0, 3000, 'A to let go');

  // B downloads a whole file and finishes.
  const b = await get({ Range: `bytes=0-${END}` });
  assert.equal(b.res.statusCode, 206, 'B is not refused');
  assert.equal(b.body.length, END + 1);
  await waitFor(() => engine.streamCount(HASH) === 0, 3000, 'B to let go');

  // A resumes from where it stopped.
  const resumeFrom = Math.min(got, 200_000);
  const a2 = await get({ Range: `bytes=${resumeFrom}-${END}` });
  assert.equal(a2.res.statusCode, 206, 'A resumes rather than getting 409 busy');
  assert.equal(a2.body.length, END - resumeFrom + 1);
  assert.ok(a2.body.every((byte) => byte === 7), 'and the bytes are the right ones');
  assert.equal(torrent.file.open, 0, 'no window left open behind any of it');
});

test('a download that finishes normally releases too', async (t) => {
  const { engine, torrent, server, stop, ready } = harness();
  await ready;
  t.after(stop);

  const port = server.address().port;
  const req = http.get({ port, path: `/torrent/${HASH}/0`, headers: { Range: 'bytes=0-99' } });
  const [res] = await once(req, 'response');
  assert.equal(res.statusCode, 206);

  let bytes = 0;
  for await (const chunk of res) bytes += chunk.length;
  assert.equal(bytes, 100);

  await waitFor(() => engine.streamCount(HASH) === 0, 1000, 'the read to be released');
  assert.equal(torrent.file.open, 0);
});

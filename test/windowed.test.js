import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { windows, windowedStream } from '../src/lib/windowed.js';

/* A stand-in for a webtorrent File that records how it was read. The counters are the point:
 * every claim the zip route makes about memory is a claim about when and how often
 * createReadStream is called. */
function fakeFile(length, log = []) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 251; // prime stride, so an offset slip shows
  return {
    length,
    bytes,
    log,
    open: 0,
    maxOpen: 0,
    createReadStream({ start = 0, end = length - 1 } = {}) {
      this.log.push([start, end]);
      this.open++;
      this.maxOpen = Math.max(this.maxOpen, this.open);
      const self = this;
      const slice = bytes.subarray(start, end + 1);
      const stream = Readable.from(
        (async function* () {
          // 64 KB at a time, the way a socket would.
          for (let at = 0; at < slice.length; at += 65536) {
            yield slice.subarray(at, Math.min(at + 65536, slice.length));
          }
        })()
      );
      const done = () => {
        if (!stream.flaiClosed) {
          stream.flaiClosed = true;
          self.open--;
        }
      };
      stream.on('end', done);
      stream.on('close', done);
      // Wrapped so the counter moves synchronously. A real destroy() emits 'close' a tick
      // later, which would make "was this closed?" a race in the assertions rather than a
      // question about the code under test.
      const destroy = stream.destroy.bind(stream);
      stream.destroy = (...args) => {
        done();
        return destroy(...args);
      };
      return stream;
    },
  };
}

const collect = async (iterable) => {
  const out = [];
  for await (const chunk of iterable) out.push(Buffer.from(chunk));
  return Buffer.concat(out);
};

const WINDOW = 1024 * 1024;

test('reads the whole file across windows, byte for byte', async () => {
  const file = fakeFile(5 * WINDOW + 12345);
  const out = await collect(windows(file, WINDOW));
  assert.equal(out.length, file.length);
  assert.deepEqual(new Uint8Array(out), file.bytes);
});

test('splits into windows of the configured size, with a short final one', async () => {
  const file = fakeFile(2 * WINDOW + 500);
  await collect(windows(file, WINDOW));
  assert.deepEqual(file.log, [
    [0, WINDOW - 1],
    [WINDOW, 2 * WINDOW - 1],
    [2 * WINDOW, 2 * WINDOW + 499],
  ]);
});

/* The reason the zip route is possible at all. v4 deleted the zip because appending
 * file.createReadStream() for every file selects every piece of every file at once. These
 * generators can all be appended up front because an unconsumed one has done nothing. */
test('opens nothing until something reads it', async () => {
  const file = fakeFile(10 * WINDOW);
  const stream = windowedStream(file, WINDOW);
  assert.equal(file.log.length, 0, 'constructing the stream must not touch the file');

  // Ten of them, as the zip route appends them — still nothing opened.
  const many = Array.from({ length: 10 }, () => windowedStream(file, WINDOW));
  assert.equal(file.log.length, 0, 'ten unconsumed streams must not touch the file');
  for (const s of many) s.destroy();

  await collect(stream);
  assert.ok(file.log.length > 0, 'reading does open it');
});

test('never has more than one window open at a time', async () => {
  const file = fakeFile(8 * WINDOW);
  await collect(windows(file, WINDOW));
  assert.equal(file.maxOpen, 1, `expected 1 concurrent read, saw ${file.maxOpen}`);
  assert.equal(file.open, 0, 'every window was closed');
});

test('honours a byte range', async () => {
  const file = fakeFile(4 * WINDOW);
  const start = 1000;
  const end = 2 * WINDOW + 77;
  const out = await collect(windows(file, WINDOW, start, end));
  assert.equal(out.length, end - start + 1);
  assert.deepEqual(new Uint8Array(out), file.bytes.subarray(start, end + 1));
  assert.equal(file.log[0][0], start, 'first window starts where asked');
  assert.equal(file.log.at(-1)[1], end, 'last window ends where asked');
});

test('a range inside one window is a single read', async () => {
  const file = fakeFile(4 * WINDOW);
  await collect(windows(file, WINDOW, 10, 20));
  assert.deepEqual(file.log, [[10, 20]]);
});

/* A consumer that walks away — a cancelled download — must not leave a piece selection behind,
 * because the engine would keep fetching for a reader that no longer exists. */
test('abandoning the read closes the window it was on', async () => {
  const file = fakeFile(8 * WINDOW);
  const iterator = windows(file, WINDOW);
  await iterator.next();
  assert.equal(file.open, 1);
  await iterator.return();
  assert.equal(file.open, 0, 'the in-flight window was destroyed on early return');
});

/* The case the HTTP tests cannot reach: a window waiting on pieces that never arrive. The
 * generator is suspended inside its own `for await`, where closing it politely cannot reach it
 * until the next chunk lands — which is never. Destroying the stream is what unblocks it. */
test('an abort unblocks a window that is waiting on pieces that never come', async () => {
  const file = fakeFile(8 * WINDOW);
  const stalled = new Readable({ read() {} }); // yields nothing, ever
  file.createReadStream = () => {
    file.open++;
    stalled.on('close', () => file.open--);
    return stalled;
  };

  const stop = new AbortController();
  const reading = collect(windows(file, WINDOW, 0, 8 * WINDOW - 1, stop.signal));
  await new Promise((r) => setImmediate(r));
  assert.equal(file.open, 1, 'parked mid-window');

  stop.abort(new Error('client went away'));
  await assert.rejects(reading, /client went away/);
  assert.equal(file.open, 0, 'the stalled window was destroyed, not left behind');
});

test('an abort between windows stops before opening the next one', async () => {
  const file = fakeFile(8 * WINDOW);
  const stop = new AbortController();
  const iterator = windows(file, WINDOW, 0, 8 * WINDOW - 1, stop.signal);
  await iterator.next();
  await iterator.return(); // finishes the current window
  stop.abort(new Error('handed over'));
  assert.equal(file.log.length, 1, 'only the first window was ever opened');
});

test('an abort before the first read opens nothing at all', async () => {
  const file = fakeFile(8 * WINDOW);
  const stop = new AbortController();
  stop.abort(new Error('handed over'));
  await assert.rejects(collect(windows(file, WINDOW, 0, 8 * WINDOW - 1, stop.signal)), /handed over/);
  assert.equal(file.log.length, 0);
});

test('a zero-length file reads as nothing and opens nothing', async () => {
  const file = fakeFile(0);
  assert.equal((await collect(windows(file, WINDOW))).length, 0);
  assert.equal(file.log.length, 0);
});

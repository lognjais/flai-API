import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowStore, storeFor } from '../src/engine/window-store.js';

const PIECE = 1024;
const piece = (byte) => new Uint8Array(PIECE).fill(byte);

/** Promisified store calls, because the interface is callback-based. */
const put = (s, i, buf) => new Promise((res, rej) => s.put(i, buf, (e) => (e ? rej(e) : res())));
const get = (s, i, opts) =>
  new Promise((res, rej) => s.get(i, opts, (e, b) => (e ? rej(e) : res(b))));

test('serves back what it stored', async () => {
  const s = new SlidingWindowStore(PIECE, { budgetBytes: PIECE * 8 });
  await put(s, 0, piece(7));
  assert.deepEqual(await get(s, 0), piece(7));
  assert.deepEqual(await get(s, 0, { offset: 2, length: 3 }), new Uint8Array([7, 7, 7]));
});

test('an unwritten piece errors rather than returning empty bytes', async () => {
  const s = new SlidingWindowStore(PIECE, { budgetBytes: PIECE * 8 });
  await assert.rejects(get(s, 3), (err) => err.code === 'CHUNK_EVICTED');
});

test('stays inside its byte budget', async () => {
  const budget = PIECE * 4;
  const s = new SlidingWindowStore(PIECE, { budgetBytes: budget });
  for (let i = 0; i < 40; i++) await put(s, i, piece(i & 0xff));
  assert.ok(s.stats().bytes <= budget, `bytes ${s.stats().bytes} > budget ${budget}`);
  assert.ok(s.stats().evictions > 0);
});

test('evicts the oldest first, so a forward reader keeps what it needs', async () => {
  // Four pieces is the budget floor, so ask for exactly that and the arithmetic is visible.
  const s = new SlidingWindowStore(PIECE, { budgetBytes: PIECE * 4 });
  for (let i = 0; i < 6; i++) await put(s, i, piece(i));
  for (const gone of [0, 1]) {
    await assert.rejects(get(s, gone), (err) => err.code === 'CHUNK_EVICTED');
  }
  for (const kept of [2, 3, 4, 5]) assert.deepEqual(await get(s, kept), piece(kept));
});

/* The invariant the whole design rests on. A reader holding a piece must not lose it to
 * pieces arriving for its own chunk — that is what makes forgetting safe without the route
 * having to publish a read-head pointer. */
test('reading a piece protects it from eviction', async () => {
  const s = new SlidingWindowStore(PIECE, { budgetBytes: PIECE * 4 });
  for (let i = 0; i < 4; i++) await put(s, i, piece(i)); // exactly at budget, nothing evicted
  await get(s, 0); // touch the oldest — it becomes the newest
  await put(s, 4, piece(4)); // over budget, forces one eviction
  assert.deepEqual(await get(s, 0), piece(0), 'the touched piece survived');
  await assert.rejects(get(s, 1), (err) => err.code === 'CHUNK_EVICTED');
});

test('budget floor is four pieces, however small the configured budget', async () => {
  const s = new SlidingWindowStore(PIECE, { budgetBytes: 1 });
  assert.equal(s.stats().budget, PIECE * 4);
});

test('never evicts its last piece, so a huge piece length still works', async () => {
  const s = new SlidingWindowStore(PIECE, { budgetBytes: 1 });
  for (let i = 0; i < 10; i++) await put(s, i, piece(i));
  assert.equal(s.stats().pieces >= 1, true);
  assert.deepEqual(await get(s, 9), piece(9));
});

test('overwriting a piece does not double-count its bytes', async () => {
  const s = new SlidingWindowStore(PIECE, { budgetBytes: PIECE * 8 });
  await put(s, 0, piece(1));
  await put(s, 0, piece(2));
  assert.equal(s.stats().bytes, PIECE);
  assert.equal(s.stats().pieces, 1);
});

test('registers under its infohash and deregisters on close', async () => {
  const infoHash = 'a'.repeat(40);
  const s = new SlidingWindowStore(PIECE, { budgetBytes: PIECE * 4, torrent: { infoHash } });
  assert.equal(storeFor(infoHash), s);
  await new Promise((r) => s.close(r));
  assert.equal(storeFor(infoHash), null);
  assert.equal(s.stats().pieces, 0);
});

test('a closed store refuses writes instead of growing', async () => {
  const s = new SlidingWindowStore(PIECE, { budgetBytes: PIECE * 4 });
  await new Promise((r) => s.close(r));
  await assert.rejects(put(s, 0, piece(0)), /closed/);
});

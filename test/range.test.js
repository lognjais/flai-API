import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, resolveRange } from '../src/lib/range.js';

const TOTAL = 1000;
const MAX = 100;

test('parses an explicit range', () => {
  assert.deepEqual(parseRange('bytes=0-99', TOTAL), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-600', TOTAL), { start: 500, end: 600 });
});

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=900-', TOTAL), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-', TOTAL), { start: 0, end: 999 });
});

test('a suffix range counts back from the end', () => {
  assert.deepEqual(parseRange('bytes=-100', TOTAL), { start: 900, end: 999 });
  // Larger than the file: clamp to the whole file rather than a negative start.
  assert.deepEqual(parseRange('bytes=-5000', TOTAL), { start: 0, end: 999 });
});

test('an end past the file is clamped', () => {
  assert.deepEqual(parseRange('bytes=990-99999', TOTAL), { start: 990, end: 999 });
});

test('unsatisfiable and malformed ranges are refused', () => {
  assert.equal(parseRange('bytes=1000-1001', TOTAL), null, 'start at or past EOF');
  assert.equal(parseRange('bytes=600-500', TOTAL), null, 'inverted');
  assert.equal(parseRange('bytes=-0', TOTAL), null, 'zero-length suffix');
  assert.equal(parseRange('bytes=abc-def', TOTAL), null);
  assert.equal(parseRange('items=0-99', TOTAL), null, 'wrong unit');
  assert.equal(parseRange('bytes=0-99, 200-299', TOTAL), null, 'multipart not supported');
  assert.equal(parseRange(undefined, TOTAL), null);
});

/* The clamp is the memory bound, so these are the cases that matter most. */
test('every response is capped at maxChunk', () => {
  assert.deepEqual(resolveRange('bytes=0-', TOTAL, MAX), { status: 206, start: 0, end: 99 });
  assert.deepEqual(resolveRange('bytes=0-999', TOTAL, MAX), { status: 206, start: 0, end: 99 });
  assert.deepEqual(resolveRange('bytes=500-999', TOTAL, MAX), { status: 206, start: 500, end: 599 });
});

test('a range smaller than the cap is served whole', () => {
  assert.deepEqual(resolveRange('bytes=10-19', TOTAL, MAX), { status: 206, start: 10, end: 19 });
});

test('the final short chunk is not padded past EOF', () => {
  assert.deepEqual(resolveRange('bytes=950-', TOTAL, MAX), { status: 206, start: 950, end: 999 });
});

test('no Range header on a small file is a normal 200', () => {
  assert.deepEqual(resolveRange(undefined, 50, MAX), { status: 200, start: 0, end: 49 });
});

test('no Range header on a big file is refused, not silently truncated', () => {
  // Serving fewer bytes than Content-Length would corrupt every client, and lying about
  // Content-Length is worse. 416 with a reason is the only honest answer.
  assert.equal(resolveRange(undefined, TOTAL, MAX).status, 416);
});

test('a malformed Range is refused rather than treated as the whole file', () => {
  assert.equal(resolveRange('bytes=zzz', TOTAL, MAX).status, 416);
  assert.equal(resolveRange('bytes=2000-3000', TOTAL, MAX).status, 416);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, resolveRange } from '../src/lib/range.js';

const TOTAL = 1000;

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

/* v4.0 clamped every response to 16 MB and refused un-ranged requests, so a plain browser
 * download could not work. The bound moved inside routes/stream.js, which reads the file in
 * windows and writes them into one long response. So these now assert the opposite: nothing is
 * truncated, and a request with no Range gets the whole file. */
test('a range is honoured exactly as asked, never truncated', () => {
  assert.deepEqual(resolveRange('bytes=0-', TOTAL), { status: 206, start: 0, end: 999 });
  assert.deepEqual(resolveRange('bytes=0-999', TOTAL), { status: 206, start: 0, end: 999 });
  assert.deepEqual(resolveRange('bytes=500-999', TOTAL), { status: 206, start: 500, end: 999 });
  assert.deepEqual(resolveRange('bytes=10-19', TOTAL), { status: 206, start: 10, end: 19 });
});

/* Chrome's download manager resumes an interrupted download with `bytes=N-`. Truncating that
 * would restart the transfer from the wrong offset and corrupt the file. */
test('a resume range runs to the end of the file', () => {
  assert.deepEqual(resolveRange('bytes=950-', TOTAL), { status: 206, start: 950, end: 999 });
});

test('no Range header means the whole file, whatever its size', () => {
  assert.deepEqual(resolveRange(undefined, 50), { status: 200, start: 0, end: 49 });
  assert.deepEqual(resolveRange(undefined, 5_000_000_000), { status: 200, start: 0, end: 4_999_999_999 });
});

test('an unsatisfiable Range is refused rather than silently served', () => {
  assert.equal(resolveRange('bytes=zzz', TOTAL).status, 416);
  assert.equal(resolveRange('bytes=2000-3000', TOTAL).status, 416);
});

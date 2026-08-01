import test from 'node:test';
import assert from 'node:assert/strict';
import { ReaderLock } from '../src/engine/reader-lock.js';

const HASH = 'a'.repeat(40);
const noop = () => {};

test('counts what is open', () => {
  const lock = new ReaderLock();
  assert.equal(lock.count(HASH), 0);
  const release = lock.acquire(HASH, { abort: noop });
  assert.equal(lock.count(HASH), 1);
  release();
  assert.equal(lock.count(HASH), 0);
});

test('releasing twice does not go negative or free somebody else', () => {
  const lock = new ReaderLock();
  const first = lock.acquire(HASH, { abort: noop });
  first();
  const second = lock.acquire(HASH, { abort: noop });
  first(); // a finally that runs after an early return, say
  assert.equal(lock.count(HASH), 1, 'the second reader still holds it');
  second();
  assert.equal(lock.count(HASH), 0);
});

test('taking over a free key is immediate', async () => {
  const lock = new ReaderLock();
  assert.equal(await lock.takeOver(HASH, 50), true);
});

/* The whole point. The incumbent is asked to stop, and takeOver does not resolve until it has
 * actually let go — otherwise the newcomer opens a second window on the same torrent. */
test('taking over aborts the incumbent and waits for it to let go', async () => {
  const lock = new ReaderLock();
  let asked = false;
  const release = lock.acquire(HASH, {
    abort: () => {
      asked = true;
      // What the route does: unwind, then release from its finally, a tick later.
      setTimeout(release, 10);
    },
  });

  const start = process.hrtime.bigint();
  assert.equal(await lock.takeOver(HASH, 1000), true);
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

  assert.ok(asked, 'the incumbent was asked to stop');
  assert.equal(lock.count(HASH), 0, 'and had actually let go before takeOver resolved');
  assert.ok(elapsed >= 5, `waited for the release, not just fired and forgotten (${elapsed}ms)`);
});

test('a reader that will not let go is reported, not waited on forever', async () => {
  const lock = new ReaderLock();
  lock.acquire(HASH, { abort: noop }); // asked to stop, ignores it
  assert.equal(await lock.takeOver(HASH, 30), false);
  assert.equal(lock.count(HASH), 1, 'still held, so the caller must refuse the newcomer');
});

test('an abort callback that throws does not wedge the handover', async () => {
  const lock = new ReaderLock();
  const release = lock.acquire(HASH, {
    abort: () => {
      setTimeout(release, 5);
      throw new Error('response already destroyed');
    },
  });
  assert.equal(await lock.takeOver(HASH, 1000), true);
});

/* The other half of the rule, and the reason it is not simply "the newcomer wins". Two people
 * pulling files from one torrent would otherwise take the window from each other in turn and
 * neither would finish. */
test('a reader that is actually downloading keeps the window', async () => {
  const lock = new ReaderLock();
  let aborted = false;
  lock.acquire(HASH, { abort: () => { aborted = true; }, healthy: () => true });

  assert.equal(await lock.takeOver(HASH, 1000), false);
  assert.equal(aborted, false, 'a live download is not even asked to stop');
  assert.equal(lock.count(HASH), 1);
});

test('one live reader protects the window even if another is idle', async () => {
  const lock = new ReaderLock();
  lock.acquire(HASH, { abort: noop, healthy: () => false });
  lock.acquire(HASH, { abort: noop, healthy: () => true });
  assert.equal(await lock.takeOver(HASH, 100), false);
  assert.equal(lock.count(HASH), 2, 'nobody was aborted');
});

test('a reader that stops making progress can be taken over', async () => {
  const lock = new ReaderLock();
  let live = true;
  const release = lock.acquire(HASH, { abort: () => release(), healthy: () => live });

  assert.equal(await lock.takeOver(HASH, 100), false, 'busy while it is downloading');
  live = false; // the socket went quiet
  assert.equal(await lock.takeOver(HASH, 1000), true, 'taken over once it stalls');
});

test('a healthy() that throws is treated as not healthy', async () => {
  const lock = new ReaderLock();
  const release = lock.acquire(HASH, {
    abort: () => release(),
    healthy: () => { throw new Error('response gone'); },
  });
  assert.equal(await lock.takeOver(HASH, 1000), true);
});

test('losing the torrent aborts a live reader too', () => {
  const lock = new ReaderLock();
  let aborted = false;
  lock.acquire(HASH, { abort: () => { aborted = true; }, healthy: () => true });
  lock.abortAll(HASH);
  assert.ok(aborted, 'the torrent is gone, so healthy or not, the read must stop');
  assert.equal(lock.count(HASH), 0);
});

test('two keys are independent', async () => {
  const lock = new ReaderLock();
  const other = 'b'.repeat(40);
  lock.acquire(HASH, { abort: noop });
  const release = lock.acquire(other, { abort: () => release() });
  assert.equal(await lock.takeOver(other, 100), true);
  assert.equal(lock.count(HASH), 1, 'the other torrent was left alone');
});

test('losing the torrent aborts and clears its readers', () => {
  const lock = new ReaderLock();
  let aborted = 0;
  lock.acquire(HASH, { abort: () => aborted++ });
  lock.acquire(HASH, { abort: () => aborted++ });
  lock.abortAll(HASH);
  assert.equal(aborted, 2);
  assert.equal(lock.count(HASH), 0);
});

/* abortAll drops the key while its readers are still unwinding. Their release() then lands
 * after a newcomer has acquired the same key, and must not free the newcomer's slot. */
test('a late release from a cleared reader cannot free the newcomer', () => {
  const lock = new ReaderLock();
  const stale = lock.acquire(HASH, { abort: noop });
  lock.abortAll(HASH);
  lock.acquire(HASH, { abort: noop });
  stale();
  assert.equal(lock.count(HASH), 1);
});

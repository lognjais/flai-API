import { Readable } from 'node:stream';

/* Reading a torrent file in bounded windows.
 *
 * This is the memory bound, factored out so the single-file route and the zip route cannot
 * drift apart. webtorrent's FileIterator takes a stream selection over exactly the pieces a
 * createReadStream covers and drops it when the stream closes, and torrents are added with
 * `deselect: true`, so nothing else ever selects anything. Reading a file as a sequence of
 * windows therefore caps what the engine can want, regardless of the file's size.
 *
 * ── the laziness is load-bearing ──────────────────────────────────────────────
 *
 * An async generator does not run a line of its body until something reads from it. That is
 * what makes the zip route possible at all. v4 deleted the zip because archiver's obvious
 * usage —
 *
 *   for (const file of torrent.files) zip.append(file.createReadStream(), { name: file.path })
 *
 * — calls createReadStream() for every file before archiver has consumed any of them, so every
 * piece of every file is selected at once and the sliding window is meaningless. Appending
 * these generators instead is safe even though they are all appended up front: archiver
 * consumes them one at a time, and until it does, each one is an object that has done nothing.
 */

/**
 * @param {object} file          a webtorrent File
 * @param {number} windowBytes   how much to have in flight at once
 * @param {number} [start]       first byte, inclusive
 * @param {number} [end]         last byte, inclusive; defaults to the end of the file
 * @returns {import('node:stream').Readable}
 */
export function windowedStream(file, windowBytes, start = 0, end = file.length - 1) {
  return Readable.from(windows(file, windowBytes, start, end));
}

/**
 * @param {AbortSignal} [signal] stops the read wherever it is, including mid-window. Closing
 *   the generator is not enough on its own: a window waiting on pieces that will never arrive
 *   leaves the generator suspended inside its own `for await`, where `.return()` cannot reach
 *   it until the next chunk lands. Destroying the stream is what actually unblocks it.
 */
export async function* windows(file, windowBytes, start = 0, end = file.length - 1, signal) {
  for (let at = start; at <= end; ) {
    signal?.throwIfAborted();
    const stop = Math.min(end, at + windowBytes - 1);
    const window = file.createReadStream({ start: at, end: stop });
    const cancel = () => window.destroy(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      for await (const chunk of window) yield chunk;
    } finally {
      signal?.removeEventListener('abort', cancel);
      // Drops the piece selection even when the consumer walks away mid-window.
      window.destroy();
    }
    at = stop + 1;
  }
}

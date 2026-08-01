/* SlidingWindowStore — an abstract-chunk-store that forgets.
 *
 * This is the whole reason flai v4 fits on the free tier. Every other chunk store answers
 * "where do the pieces live"; this one answers "which pieces are we allowed to still have".
 *
 * v3 used webtorrent's default FSChunkStore, which keeps every piece of every torrent. On
 * Render's free tier there is no persistent disk at all and the ephemeral filesystem is
 * wiped on each spin-down, so a 4.6 GB file had nowhere to go and 512 MB of RAM to fail in.
 * That is the "big downloads die partway" bug.
 *
 * ── why forgetting is safe ────────────────────────────────────────────────────
 *
 * Because the reader walks the file forward in READ_WINDOW_BYTES windows and never goes back.
 * The pieces it can still ask for are the ones it just touched — which under LRU are exactly
 * the ones kept.
 *
 * LRU rather than "drop everything below the read head" is deliberate: `get` touches a
 * piece, so anything the current stream is actively reading is by definition the most
 * recently used, and cannot be evicted by pieces arriving for the same stream. That makes
 * the safety argument local to this file instead of depending on the route to keep a head
 * pointer honest.
 *
 * ── what happens when we get it wrong ─────────────────────────────────────────
 *
 * A read of an evicted piece calls back with CHUNK_EVICTED. webtorrent's FileIterator
 * destroys the stream on a store error, so the HTTP response ends short. The route notices
 * the short write and resets the torrent — which clears the bitfield, so the pieces can be
 * fetched again — and the client retries the chunk. Slow, correct, and self-healing. It is
 * the path a backwards seek past the window takes.
 */

/** infoHash -> store instance, so the engine can report window stats without plumbing. */
const registry = new Map();

export function storeFor(infoHash) {
  return registry.get(infoHash) ?? null;
}

export class SlidingWindowStore {
  #chunks = new Map(); // index -> Uint8Array, in LRU order (oldest first)
  #bytes = 0;
  #budget;
  #infoHash = null;
  #evictions = 0;
  #closed = false;

  /**
   * webtorrent calls `new store(pieceLength, opts)` with opts.torrent and anything passed
   * as client `storeOpts`. See lib/torrent.js — the shape is not documented anywhere else.
   */
  constructor(chunkLength, opts = {}) {
    this.chunkLength = chunkLength;
    /* Four pieces is the floor, whatever the caller asks for. Piece length is chosen by
     * whoever made the torrent and can be 16 MB, so a budget expressed in bytes alone could
     * land below a single piece and evict the piece being read. */
    this.#budget = Math.max(opts.budgetBytes ?? 32 * 1024 * 1024, chunkLength * 4);
    this.#infoHash = opts.torrent?.infoHash ?? null;
    if (this.#infoHash) registry.set(this.#infoHash, this);
  }

  put(index, buf, cb = () => {}) {
    if (this.#closed) return queueMicrotask(() => cb(new Error('store is closed')));
    const existing = this.#chunks.get(index);
    if (existing) this.#bytes -= existing.length;
    this.#chunks.delete(index); // re-insert so Map order stays newest-last
    this.#chunks.set(index, buf);
    this.#bytes += buf.length;
    this.#evict();
    queueMicrotask(() => cb(null));
  }

  get(index, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = null;
    }
    cb ??= () => {};

    const buf = this.#chunks.get(index);
    if (!buf) {
      const err = new Error(`chunk ${index} was evicted from the sliding window`);
      err.code = 'CHUNK_EVICTED';
      return queueMicrotask(() => cb(err));
    }

    // Touch: this is what protects the piece the current stream is reading.
    this.#chunks.delete(index);
    this.#chunks.set(index, buf);

    if (!opts) return queueMicrotask(() => cb(null, buf));
    const offset = opts.offset ?? 0;
    const length = opts.length ?? buf.length - offset;
    queueMicrotask(() => cb(null, buf.subarray(offset, offset + length)));
  }

  #evict() {
    while (this.#bytes > this.#budget && this.#chunks.size > 1) {
      // Map iteration order is insertion order, so the first key is the least recently used.
      const oldest = this.#chunks.keys().next().value;
      this.#bytes -= this.#chunks.get(oldest).length;
      this.#chunks.delete(oldest);
      this.#evictions++;
    }
  }

  stats() {
    return {
      pieces: this.#chunks.size,
      bytes: this.#bytes,
      budget: this.#budget,
      evictions: this.#evictions,
    };
  }

  close(cb = () => {}) {
    this.#closed = true;
    this.#chunks.clear();
    this.#bytes = 0;
    if (this.#infoHash && registry.get(this.#infoHash) === this) registry.delete(this.#infoHash);
    queueMicrotask(() => cb(null));
  }

  destroy(cb = () => {}) {
    this.close(cb);
  }
}

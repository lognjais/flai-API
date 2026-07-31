import { config } from '../config.js';
import { logger } from '../logger.js';
import { SlidingWindowStore, storeFor } from './window-store.js';

/* Trackers on top of whatever the magnet carries. The WSS entries are near-useless for a
 * Node client fetching real swarms — qBittorrent and Transmission ship WebTorrent support
 * off — but they cost nothing and occasionally find a web seed. DHT does the real work. */
const ANNOUNCE = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
];

export class TorrentEngine {
  #client = null;
  #ready;
  #torrents = new Map();       // infoHash -> Torrent
  #uris = new Map();           // infoHash -> magnet, so reset() can re-add
  #pending = new Map();        // infoHash -> Promise<Torrent>
  #lastTouched = new Map();    // infoHash -> ms
  #streams = new Map();        // infoHash -> active stream count
  #evictTimer = null;
  #bytesServed = 0;

  constructor() {
    this.#ready = this.#init();
  }

  async #init() {
    const { default: WebTorrent } = await import('webtorrent');
    this.#client = new WebTorrent({
      maxConns: config.MAX_CONNS,
      dht: true,
      tracker: { announce: ANNOUNCE },
    });
    this.#client.on('error', (err) => logger.warn({ err: err.message }, 'webtorrent client error'));
    this.#evictTimer = setInterval(() => this.#evictIdle(), 60_000);
    this.#evictTimer.unref?.();
    logger.info(
      { maxActive: config.MAX_ACTIVE_TORRENTS, maxConns: config.MAX_CONNS },
      'torrent engine ready'
    );
  }

  async ready() {
    await this.#ready;
    return this;
  }

  async addOrGet({ uri, infoHash }) {
    await this.ready();
    this.#touch(infoHash);

    const existing = this.#torrents.get(infoHash);
    if (existing) return existing;

    const inflight = this.#pending.get(infoHash);
    if (inflight) return inflight;

    if (this.#torrents.size >= config.MAX_ACTIVE_TORRENTS) this.#evictOne();

    const promise = this.#add(uri, infoHash);
    this.#pending.set(infoHash, promise);
    return promise;
  }

  #add(uri, infoHash) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const torrent = this.#client.add(
        uri,
        {
          announce: ANNOUNCE,
          /* The bound. With deselect the torrent starts wanting nothing, and the only thing
           * that ever selects pieces is webtorrent's own FileIterator, which selects exactly
           * the range a createReadStream covers and drops the selection when the stream
           * closes. Because the route clamps every Range to MAX_CHUNK_BYTES, the engine can
           * never want more than one chunk of pieces at a time. */
          deselect: true,
          store: SlidingWindowStore,
          storeOpts: { budgetBytes: config.WINDOW_BUDGET_BYTES },
          // Our store already holds recent pieces; webtorrent's own 20-piece cache in front
          // of it would just pay for the same bytes twice.
          storeCacheSlots: 0,
          destroyStoreOnDestroy: true,
        },
        (t) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#torrents.set(t.infoHash, t);
          this.#uris.set(t.infoHash, uri);
          this.#pending.delete(infoHash);
          this.#wire(t);
          resolve(t);
        }
      );

      torrent.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pending.delete(infoHash);
        // "duplicate torrent" means the original is already ours — recover rather than fail.
        if (/duplicate torrent/i.test(err.message)) {
          const cached = this.#torrents.get(infoHash);
          if (cached) return resolve(cached);
        }
        this.#safeRemove(torrent.infoHash);
        reject(err);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#pending.delete(infoHash);
        this.#safeRemove(torrent.infoHash);
        reject(new Error(`metadata fetch timed out after ${config.METADATA_TIMEOUT_MS}ms`));
      }, config.METADATA_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  /** Synchronous lookup. Returns null when absent or metadata has not landed yet. */
  get(infoHash) {
    const t = this.#torrents.get(infoHash);
    if (!t?.ready) return null;
    this.#touch(infoHash);
    return t;
  }

  /* Clears the bitfield so evicted pieces can be fetched again.
   *
   * Needed because eviction and the bitfield disagree by design: webtorrent still believes
   * it has every verified piece, so it will not re-request one the store has dropped. A
   * backwards seek past the window, or a second pass over a file the store has forgotten,
   * therefore has exactly one cure — start the torrent over. Metadata comes back from the
   * magnet in milliseconds; peers take a few seconds. */
  async reset(infoHash) {
    const uri = this.#uris.get(infoHash);
    if (!uri) return null;
    logger.info({ infoHash }, 'resetting torrent (window passed)');
    this.#forget(infoHash);
    this.#safeRemove(infoHash);
    return this.addOrGet({ uri, infoHash });
  }

  #wire(torrent) {
    torrent.on('error', (err) =>
      logger.warn({ err: err.message, infoHash: torrent.infoHash }, 'torrent error')
    );
    torrent.on('close', () => this.#forget(torrent.infoHash));
  }

  #forget(infoHash) {
    this.#torrents.delete(infoHash);
    this.#lastTouched.delete(infoHash);
    this.#streams.delete(infoHash);
  }

  #touch(infoHash) {
    this.#lastTouched.set(infoHash, Date.now());
  }

  #evictIdle() {
    const cutoff = Date.now() - config.TORRENT_IDLE_EVICT_MS;
    for (const infoHash of [...this.#torrents.keys()]) {
      const idle = (this.#lastTouched.get(infoHash) ?? 0) < cutoff;
      if (idle && (this.#streams.get(infoHash) ?? 0) === 0) this.#remove(infoHash, 'idle');
    }
  }

  #evictOne() {
    if (this.#torrents.size === 0) return;
    const byAge = [...this.#torrents.keys()].sort(
      (a, b) => (this.#lastTouched.get(a) ?? 0) - (this.#lastTouched.get(b) ?? 0)
    );
    const victim = byAge.find((h) => (this.#streams.get(h) ?? 0) === 0) ?? byAge[0];
    this.#remove(victim, 'capacity');
  }

  #remove(infoHash, reason) {
    this.#forget(infoHash);
    this.#uris.delete(infoHash);
    this.#safeRemove(infoHash);
    logger.info({ infoHash, reason }, 'torrent evicted');
  }

  #safeRemove(infoHash) {
    if (!this.#client || !infoHash) return;
    try {
      this.#client.remove(infoHash, { destroyStore: true }, (err) => {
        if (err) logger.warn({ err: err.message, infoHash }, 'remove failed');
      });
    } catch (err) {
      logger.warn({ err: err.message, infoHash }, 'remove threw');
    }
  }

  /** How many HTTP reads are open on this torrent. One window, so one reader. */
  streamCount(infoHash) {
    return this.#streams.get(infoHash) ?? 0;
  }

  trackStream(torrent) {
    const h = torrent.infoHash;
    this.#streams.set(h, this.streamCount(h) + 1);
    this.#touch(h);
    return (bytes = 0) => {
      this.#bytesServed += bytes;
      this.#streams.set(h, Math.max(0, this.streamCount(h) - 1));
      this.#touch(h);
    };
  }

  stats() {
    if (!this.#client) return { ready: false, torrents: 0 };
    return {
      ready: true,
      torrents: this.#torrents.size,
      maxTorrents: config.MAX_ACTIVE_TORRENTS,
      downloadSpeed: this.#client.downloadSpeed,
      uploadSpeed: this.#client.uploadSpeed,
      bytesServed: this.#bytesServed,
      rss: process.memoryUsage.rss(),
      windows: [...this.#torrents.keys()].map((h) => ({
        infoHash: h,
        streams: this.streamCount(h),
        ...(storeFor(h)?.stats() ?? {}),
      })),
    };
  }

  async destroy() {
    if (this.#evictTimer) clearInterval(this.#evictTimer);
    this.#torrents.clear();
    this.#pending.clear();
    this.#uris.clear();
    this.#lastTouched.clear();
    this.#streams.clear();
    if (this.#client) {
      await new Promise((resolve) => this.#client.destroy(() => resolve()));
      logger.info('torrent engine destroyed');
    }
  }
}

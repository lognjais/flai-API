import { config } from './config.js';
import { logger } from './logger.js';

const ANNOUNCE = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
];

const METADATA_TIMEOUT_MS = 60_000;

export class TorrentEngine {
  #client = null;
  #ready;
  #torrents = new Map();          // infohash -> Torrent (sync lookup)
  #pending = new Map();           // infohash -> Promise<Torrent>
  #lastTouched = new Map();       // infohash -> timestamp
  #activeStreams = new Map();     // infohash -> count
  #evictTimer = null;

  constructor() {
    this.#ready = this.#init();
  }

  async #init() {
    const { default: WebTorrent } = await import('webtorrent');
    this.#client = new WebTorrent({
      maxConns: 80,
      dht: true,
      tracker: { announce: ANNOUNCE },
    });
    this.#client.on('error', (err) => {
      logger.warn({ err: err.message }, 'webtorrent client error');
    });
    this.#evictTimer = setInterval(() => this.#evictIdle(), 60_000);
    this.#evictTimer.unref?.();
    logger.info('torrent engine ready');
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

    if (this.#torrents.size >= config.MAX_ACTIVE_TORRENTS) {
      this.#evictOne();
    }

    const promise = new Promise((resolve, reject) => {
      let settled = false;
      const torrent = this.#client.add(uri, { announce: ANNOUNCE }, (t) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.#torrents.set(t.infoHash, t);
        this.#pending.delete(infoHash);
        this.#wireTorrent(t);
        resolve(t);
      });
      torrent.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.#pending.delete(infoHash);
        // "duplicate torrent" means the original is already in our cache — recover.
        if (/duplicate torrent/i.test(err.message)) {
          const cached = this.#torrents.get(infoHash);
          if (cached) return resolve(cached);
        }
        this.#safeRemove(torrent.infoHash);
        reject(err);
      });
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#pending.delete(infoHash);
        this.#safeRemove(torrent.infoHash);
        reject(new Error('metadata fetch timed out after 60s'));
      }, METADATA_TIMEOUT_MS);
      timeoutHandle.unref?.();
    });

    this.#pending.set(infoHash, promise);
    return promise;
  }

  /** Synchronous lookup — returns null if absent or not yet ready. */
  get(infoHash) {
    const t = this.#torrents.get(infoHash);
    if (!t) return null;
    if (!t.ready) return null;
    this.#touch(infoHash);
    return t;
  }

  #wireTorrent(torrent) {
    torrent.on('error', (err) => {
      logger.warn({ err: err.message, infoHash: torrent.infoHash }, 'torrent error');
    });
    torrent.on('close', () => {
      this.#torrents.delete(torrent.infoHash);
      this.#lastTouched.delete(torrent.infoHash);
      this.#activeStreams.delete(torrent.infoHash);
    });
  }

  #touch(infoHash) {
    this.#lastTouched.set(infoHash, Date.now());
  }

  #evictIdle() {
    const cutoff = Date.now() - config.TORRENT_IDLE_EVICT_MS;
    for (const [infoHash] of this.#torrents) {
      const last = this.#lastTouched.get(infoHash) ?? 0;
      const streams = this.#activeStreams.get(infoHash) ?? 0;
      if (last < cutoff && streams === 0) {
        this.#remove(infoHash, 'idle');
      }
    }
  }

  #evictOne() {
    if (this.#torrents.size === 0) return;
    const sorted = [...this.#torrents.keys()].sort(
      (a, b) => (this.#lastTouched.get(a) ?? 0) - (this.#lastTouched.get(b) ?? 0)
    );
    const victim = sorted.find((h) => (this.#activeStreams.get(h) ?? 0) === 0) ?? sorted[0];
    this.#remove(victim, 'capacity');
  }

  #remove(infoHash, reason) {
    this.#torrents.delete(infoHash);
    this.#lastTouched.delete(infoHash);
    this.#activeStreams.delete(infoHash);
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

  trackStream(torrent) {
    const h = torrent.infoHash;
    this.#activeStreams.set(h, (this.#activeStreams.get(h) ?? 0) + 1);
    this.#touch(h);
    return () => {
      const next = Math.max(0, (this.#activeStreams.get(h) ?? 1) - 1);
      this.#activeStreams.set(h, next);
      this.#touch(h);
    };
  }

  stats() {
    if (!this.#client) return { ready: false, torrents: 0 };
    return {
      ready: true,
      torrents: this.#torrents.size,
      downloadSpeed: this.#client.downloadSpeed,
      uploadSpeed: this.#client.uploadSpeed,
      progress: this.#client.progress,
    };
  }

  async destroy() {
    if (this.#evictTimer) clearInterval(this.#evictTimer);
    this.#torrents.clear();
    this.#pending.clear();
    this.#lastTouched.clear();
    this.#activeStreams.clear();
    if (this.#client) {
      await new Promise((resolve) => this.#client.destroy(() => resolve()));
      logger.info('torrent engine destroyed');
    }
  }
}

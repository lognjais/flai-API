/* One reader per torrent, with handover.
 *
 * The sliding window is per torrent, so two readers at different offsets evict each other's
 * pieces and both crawl. The rule is therefore one open read per torrent — but the first
 * version enforced it by refusing the newcomer with 409 busy, and that was the wrong half of
 * the problem.
 *
 * From inside the server, a read the client walked away from looks exactly like a healthy one.
 * A cancelled download, a slept laptop, a dropped wifi: the reader is still on the books. Until
 * it is cleared, every retry is refused — and because idle eviction also skips a torrent that
 * is being read, the torrent itself stays pinned in one of only two slots.
 *
 * So a newcomer can take the window — but only from a reader that is not using it. `healthy`
 * is what tells the two apart: a reader still writing bytes to a live socket keeps the window,
 * and the newcomer is refused. Anything else — already unwinding, socket gone, nothing written
 * for a long time — is handed over.
 *
 * Without that check the newcomer would always win, and two people downloading from the same
 * torrent would take it from each other in turn, each interrupting the other's progress, with
 * neither finishing. Refusing a live download is the honest answer; taking over a dead one is
 * the whole point.
 */
export class ReaderLock {
  #readers = new Map(); // key -> Set<{ abort, done }>

  /** How many reads are open on this key. */
  count(key) {
    return this.#readers.get(key)?.size ?? 0;
  }

  /**
   * @param {string} key
   * @param {object} [opts]
   * @param {() => void} [opts.abort]     called when someone else needs this key, or it goes away
   * @param {() => boolean} [opts.healthy] is this reader actually using the window right now?
   * @returns {() => void} release — idempotent, safe to call from a finally
   */
  acquire(key, { abort = () => {}, healthy = () => false } = {}) {
    let settle;
    const reader = { abort, healthy, done: new Promise((resolve) => { settle = resolve; }) };

    let set = this.#readers.get(key);
    if (!set) this.#readers.set(key, (set = new Set()));
    set.add(reader);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      set.delete(reader);
      // Only drop the key if this is still the live set — abortAll may have replaced it.
      if (set.size === 0 && this.#readers.get(key) === set) this.#readers.delete(key);
      settle();
    };
  }

  /**
   * Asks every idle reader of `key` to stop, and waits for them to let go.
   * @returns {Promise<boolean>} true once the key is free; false if a live download holds it,
   *   or if someone asked to stop would not let go
   */
  async takeOver(key, timeoutMs) {
    const set = this.#readers.get(key);
    if (!set?.size) return true;

    // Somebody is genuinely downloading. Refuse the newcomer rather than interrupt them.
    for (const reader of set) {
      try { if (reader.healthy()) return false; } catch { /* treat a throw as not healthy */ }
    }

    const waits = [...set].map((reader) => {
      // A reader whose abort throws is exactly the reader we must not wait on forever.
      try { reader.abort(); } catch { /* already gone */ }
      return reader.done;
    });

    let timer;
    const expiry = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    timer.unref?.();
    try {
      await Promise.race([Promise.all(waits), expiry]);
    } finally {
      clearTimeout(timer);
    }
    return this.count(key) === 0;
  }

  /** The torrent is going away, so anyone reading it must stop. */
  abortAll(key) {
    for (const reader of this.#readers.get(key) ?? []) {
      try { reader.abort(); } catch { /* already gone */ }
    }
    this.#readers.delete(key);
  }

  clear() {
    for (const key of [...this.#readers.keys()]) this.abortAll(key);
  }
}

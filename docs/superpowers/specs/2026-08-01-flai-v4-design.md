# flai v4 — a downloader that fits a 512 MB box and then needs no attention

Date: 2026-08-01
Repos: [`lognjais/flai`](https://github.com/lognjais/flai) (browser), [`jvoltci/flai-api`](https://github.com/lognjais/flai-api) (bridge)

## The problem

flai v3 is a torrent-to-HTTP bridge on Render's free tier. Three things go wrong:

1. **Big downloads die partway.** A single `<a download>` for a 4.6 GB file has no retry. Any
   blip, spin-down or OOM restarts it from zero.
2. **No progress or queue.** You cannot see percent, speed, peers, or queue a second magnet.
3. **Some files never play.** MKV/AVI are marked `streamable` on extension alone, so the
   player is handed files Chrome cannot decode.

Underneath all three is one unbounded resource. v3 lets webtorrent select every piece of
every torrent and cache it, on a box with 512 MB of RAM, **no persistent disk**, and an
ephemeral filesystem wiped on every spin-down.

## Constraints (measured, not assumed — 2026-08-01)

| Constraint | Value |
|---|---|
| Render free RAM | 512 MB |
| Render free disk | **none.** Ephemeral FS, wiped on redeploy/restart/spin-down |
| Render free sleep | after 15 min with no inbound traffic; ~1 min cold start |
| Render free hours | 750/month (a month is 720–744) |
| Render free bandwidth | 100 GB/month |
| Inbound peer connections | not available — outbound + DHT only |
| Users | 2, behind one shared password |
| Browsers | Chrome/Edge only, by choice |

## Rejected alternatives

**Frontend-only (WASM).** Not possible. Browsers cannot open TCP/UDP, and WASM has no socket
access — it calls the same JS APIs. WebRTC is the only in-page P2P transport, so a browser
client only reaches "web peers"; qBittorrent and Transmission ship WebTorrent support off, so
most magnets have zero reachable web peers. Chrome's Direct Sockets API does expose TCP/UDP
but only to Isolated Web Apps on ChromeOS, which cannot be served from GitHub Pages.

**Server downloads first, then serves.** Ruled out by the host, not by taste: no persistent
disk to land the file on, and the box sleeps at 15 min so a two-hour download cannot finish.

**rqbit / confluence sidecar.** rqbit is the better engine — tens of MB of RAM, an HTTP API
with Range streaming, official Docker image. But its server only offers filesystem and mmap
storage, so a 4.6 GB file needs 4.6 GB of a disk Render does not provide. It adds a second
runtime without solving the binding constraint. Revisit the day flai moves to a box with a
disk.

**Background Fetch for downloads that survive a closed tab.** It cannot write to a
user-chosen file — bytes land in browser storage, needing 2× the space plus a copy-out. It is
also a WICG draft, not on the standards track, and had a high-severity CVE in January 2026.
Rejected as a rot risk.

## Design

### 1. The server is a bounded byte pump

```
Browser                                   flai-api (Render free, 512 MB)
┌───────────────────────────┐            ┌─────────────────────────────────┐
│ <a href="…&m=<magnet>"    │  one       │ stream route                    │
│    download>Save</a>      │ ─request─► │  reads the file as a sequence   │
│                           │            │  of 16 MB windows, writes them  │
│ Chrome's download manager │ ◄─one──────│  into one full-length response  │
│  progress, pause, resume  │  response  │                                 │
│  (Range: bytes=N-)        │            │ SlidingWindowStore (RAM, 32 MB) │
└───────────────────────────┘            │  LRU. drops the rest. no disk.  │
                                         └─────────────────────────────────┘
```

The **read window** is the bound, and it is invisible from outside. webtorrent's
`FileIterator` selects exactly the pieces one `createReadStream` covers and drops the selection
when it closes; torrents are added with `deselect: true` so nothing else ever selects anything.
Reading a file as a sequence of 16 MB windows therefore caps what the engine can want,
regardless of file size or what the client asked for. Backpressure closes the loop: a slow
client blocks the write and the swarm is never asked to run ahead.

**This replaced two earlier designs, and the history is the useful part.**

*Attempt 1* clamped every response to 16 MB and refused un-ranged requests with 416. It bounded
memory correctly and put the bound in the protocol, where it did not belong — a plain
`<a download>` could no longer work.

*Attempt 2* therefore taught the browser to stitch slices back together in a service worker.
It tested green against a fake bridge and did not work in the browser. Two designs deep into
solving a problem the route could solve by itself.

*Attempt 3* moved the loop into the route. Responses became ordinary, the client became a link,
and the service worker, the download manager, the IndexedDB job store and three tabs of UI all
got deleted.

### 2. The server holds no state, and the URL carries what it needs

Nothing is stored server-side: no database, no disk, no magnets, no progress. A spin-down or a
redeploy loses nothing because there was nothing to lose. That deletes MongoDB, `db.js`, and
the Atlas 60-day idle-pause chore.

Which leaves the obvious question — if the service forgets a torrent, how does it get it back?
**The download URL carries its own magnet:**

```
GET /torrent/<hash>/5?dl=1&t=<token>&m=magnet:?xt=urn:btih:<hash>&…
```

The route re-adds from `m` when the torrent is not resident. Combined with `Accept-Ranges` and
a stable `ETag`, that means Chrome's own download manager — which retries an interrupted
download with `Range: bytes=N-` — resumes **across a server restart with no client-side code**.

Verified end to end: a server with no prior knowledge of the torrent, given only this URL,
served all 129,241,752 bytes of a 129 MB file, with 731 window evictions and a peak RSS of
204 MB.

### 3. Units

**`SlidingWindowStore`** — `abstract-chunk-store` compliant, RAM only.

- `put(i, buf, cb)` stores and evicts the least recently used pieces while over budget.
- `get(i, opts, cb)` returns a slice, or errors with `code: 'CHUNK_EVICTED'`.
- `get` **touches** the piece, which is what protects it: whatever the current reader is
  reading is by definition the most recently used, so pieces arriving for its own slice cannot
  evict it. LRU rather than a head pointer keeps that argument local to one file instead of
  depending on the route to keep a head honest.
- The budget floor is 4 pieces however small the configured bytes, because piece length is
  chosen by whoever made the torrent and can be 16 MB.

**`TorrentEngine`** — add/get/reset, capacity 2, 5-minute idle eviction, stream refcounting.
`reset(hash)` destroys and re-adds so the bitfield clears after a seek behind the window.

**`token.js`** — `POST /session` trades the password for an HMAC-SHA256 token (12 h). Accepted
as `Authorization: Bearer` or `?t=`, because `<video src>` cannot set headers. This closes a
real hole: v3's stream URLs were entirely unauthenticated against a 100 GB/month cap.

**Client** — a link. `<a href="…?dl=1&t=…&m=…" download>Save</a>`, and the browser's own
download manager does progress, pause and resume. flai contributes no JavaScript to the
transfer. `main.tsx` unregisters any service worker it finds, because deploying a build without
one does not remove a worker a browser already installed.

**Client `probe.ts`** — fetches the first 512 KB, sniffs the container (MP4 `ftyp`/`moov`,
Matroska EBML `CodecID`), and asks `MediaSource.isTypeSupported`. When Chrome cannot decode
it, the UI says so in words and offers the stream URL for VLC/mpv/IINA, which play it fine
over Range. No server CPU, no WASM.

### 4. Caps

| | v3 | v4 | why |
|---|---|---|---|
| `MAX_ACTIVE_TORRENTS` | 8 | 2 | ~250 MB each on a 512 MB box |
| `maxConns` | 80 | 30 | per-connection buffers |
| `storeCacheSlots` | 20 (default) | 0 | our store *is* the cache |
| idle eviction | 15 min | 5 min | give RAM back sooner |
| store budget | — | 32 MB | 2× the read window; a cache fills whatever it is given |
| read window | whole file | 16 MB | inside the route, invisible to clients |
| keep-warm | every 10 min | **off** | it burned 730 of 750 free hours |

Measured, not estimated. Idle RSS is ~115 MB locally and 91 MB on Render's Linux. A complete
129 MB download peaked at 233 MB with a 64 MB store budget and 204 MB with 32 MB — which is why
the budget is 32 MB. The store is a cache: it fills whatever it is given, and only the current
window plus slack is ever needed.

### 5. Deliberate limits

- **One active stream per torrent.** Two readers at different offsets would fight over one
  window; a second distant reader gets `409 busy`. With a cap of 2 torrents you can watch one
  and download another, but not two files of the same torrent at once.
- **The zip route is removed.** `archiver` opens read streams for every file up front, which
  selects every piece at once and defeats the window bound. Per-file download has resume and
  per-file progress, which the zip never had.
- **Cancelling in Chrome cancels it.** There is no queue in the page to resume from. Everything
  short of that — server restart, spin-down, dropped connection — is handled by the
  self-healing URL plus Chrome's own Range-based retry.
- **HMAC tokens limit exposure, they are not a bandwidth cap.** A real monthly byte counter
  needs storage, and this design deletes storage. `/healthz` reports bytes served since boot.

### 6. Removed

`db.js`, `routes/links.js` (`/shorten`, `/links/:id`, `/play/:id` — never called by the
frontend), `lib/keep-warm.js`, `lib/makeid.js`, the zip route. Dependencies dropped:
`mongodb`, `archiver`.

### 7. Currency, because "finished" means it does not rot

Every dependency was 1–3 majors behind and the Dockerfile shipped `node:20-alpine`, which
reached end of life on 30 April 2026.

webtorrent 2.8.5 → 3.0.21 · express 4 → 5 · zod 3 → 4 · pino 9 → 10 ·
express-rate-limit 7 → 8 · react 18 → 19 · vite 5 → 8 · typescript 5.6 → 7 ·
Node 20 (EOL) → **24 LTS, supported to 30 April 2028**.

Express 5 forwards async errors itself, so every route loses its `try/catch/next` wrapper.

### 8. Verification

`node --test` (no new dependency) over the pure logic, which is where the invariants live:

- `SlidingWindowStore`: evicts over budget; **reading a piece protects it from eviction**;
  `get` on an evicted piece errors rather than returning empty bytes; overwriting does not
  double-count; the 4-piece floor holds; a closed store refuses writes.
- `range.js`: `bytes=0-`, suffix ranges, inverted and past-EOF ranges, and that nothing is
  truncated — a resume range runs to EOF, and no `Range` means the whole file at any size.
- `token.js`: sign/verify round trip, expiry, tamper rejection, wrong-key rejection.
- `magnet.js`: 40-hex, 32-base32, and the truncation bug that v3 fixed (kept as a guard).

Front end: `tsc --noEmit` plus `vite build`. Success criterion for the whole change is a
4 GB-class download that survives a mid-flight server restart and finishes with the right
byte count.

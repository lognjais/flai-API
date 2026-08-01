# flai v4 — a downloader that fits a 512 MB box and then needs no attention

Date: 2026-08-01
Repos: [`jvoltci/flai`](https://github.com/jvoltci/flai) (browser), [`jvoltci/flai-api`](https://github.com/jvoltci/flai-api) (bridge)

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
Browser (Chrome/Edge)                     flai-api (Render free, 512 MB)
┌───────────────────────────┐            ┌─────────────────────────────────┐
│ download-manager          │  Range     │ stream route                    │
│  • queue (IndexedDB)      │ ─8 MB──►   │  • clamps every Range to 16 MB  │
│  • sequential chunks      │  chunks    │  • 409s instead of dying        │
│  • retry with backoff     │ ◄──────    │                                 │
│  • writes to your SSD     │            │ SlidingWindowStore (RAM, 64 MB) │
│                           │            │  LRU. drops the rest. no disk.  │
│ progress / peers   ◄──────┼── SSE ─────┤                                 │
└───────────────────────────┘            │ webtorrent: added with          │
                                         │ deselect: true — only an open   │
                                         │ stream ever selects pieces      │
                                         └─────────────────────────────────┘
```

The **clamp** is the bound. Reading webtorrent's source during implementation changed this
part of the design for the better: `FileIterator` already takes a stream selection over exactly
the pieces a `createReadStream` covers and drops it when the stream closes. So adding torrents
with `deselect: true` and clamping the response is sufficient — the engine cannot want more
than one slice of pieces at a time, and the planned `selection.js` (head-pointer arithmetic,
manual select/deselect calls) was deleted before it was written. The store budget is the safety
net, not the mechanism.

### 2. The server holds no state

| State | Lives in |
|---|---|
| magnet + metadata | browser IndexedDB |
| which chunks are done | browser IndexedDB |
| where the file is saved | `FileSystemFileHandle` in IndexedDB |
| the password | `sessionStorage` |
| the server | nothing |

The server therefore *cannot* re-add a dropped torrent — it has no magnet. That is the
contract, not a gap:

```
client → GET /torrent/<hash>/0   Range: bytes=0-8388607
server → 409 { code: "not_active" }
client → POST /metadata { url: <magnet from IndexedDB> }     (silent)
client → GET /torrent/<hash>/0   Range: bytes=0-8388607      (resumes)
```

A cold start becomes a ~20 s stall in a progress bar. Nothing to back up, migrate, or unpause.
This is what deletes MongoDB, `db.js`, and the Atlas 60-day idle-pause chore.

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

**Client `public/sw.js`** — the actual downloader, revised after the first implementation.

The original design used the File System Access API: `showDirectoryPicker()` once, then
`showSaveFilePicker()` and `requestPermission()` per resume, with the queue in IndexedDB. It
worked, but it cost a folder picker, a permission prompt, a three-tab UI to manage the queue,
and it had a real defect — `requestPermission()` needs transient user activation, and the call
sat several promise ticks behind the click that triggered it.

Replaced with a service worker answering one invented URL with a `ReadableStream`. The worker
loops 8 MB `Range` slices behind that stream, so Chrome sees a single native download with the
correct `Content-Length`, lands it in Downloads with no prompt, and draws its own progress bar.
Server restarts, cold starts and dropped connections are handled inside the stream and never
reach the browser.

What it gives up: resume after the tab closes, because a native download cannot be restarted at
an offset. Everything that actually goes wrong in practice is invisible; the one unrecoverable
case is the one the user controls.

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
| window budget | — | 64 MB | 4× the response clamp |
| Range response | unbounded | clamped to 16 MB | no client can defeat the window |
| keep-warm | every 10 min | **off** | it burned 730 of 750 free hours |

Measured after implementation, which is why these numbers are lower than the first estimate:
idle RSS is ~115 MB, and one active torrent serving 38 MB of a 129 MB file sat at 145 MB with
16.9 MB resident in its window. Two torrents land near 403 MB of 512 MB.

### 5. Deliberate limits

- **One active stream per torrent.** Two readers at different offsets would fight over one
  window; a second distant reader gets `409 busy`. With a cap of 2 torrents you can watch one
  and download another, but not two files of the same torrent at once.
- **The zip route is removed.** `archiver` opens read streams for every file up front, which
  selects every piece at once and defeats the window bound. Per-file download has resume and
  per-file progress, which the zip never had.
- **The tab must stay open** for bytes to flow. It may be minimised or backgrounded. Closing it
  ends the download for good — see the `public/sw.js` note above.
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
- `range.js`: `bytes=0-`, suffix ranges, inverted and past-EOF ranges, and the clamp — including
  that a missing `Range` on a large file is refused rather than silently truncated.
- `token.js`: sign/verify round trip, expiry, tamper rejection, wrong-key rejection.
- `magnet.js`: 40-hex, 32-base32, and the truncation bug that v3 fixed (kept as a guard).

Front end: `tsc --noEmit` plus `vite build`. Success criterion for the whole change is a
4 GB-class download that survives a mid-flight server restart and finishes with the right
byte count.

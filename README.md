# flai-api

A torrent-to-HTTP bridge that **forgets**. Paste a magnet, get an ordinary HTTP download —
of a 50 GB file, from a service capped at 320 MB of RAM that writes nothing to disk.

It was built against Render's 512 MB free tier and now runs on a 1 GB box shared with three
other services, which is why the cap matters more than the box does.

```
flai/ (browser, GH Pages)  ──►  flai-api (a box you own)  ──►  BitTorrent swarm
    one <a download>              reads in 16 MB windows
```

## The one idea

v3 used webtorrent's default chunk store, which keeps every piece of every torrent. Render's
free tier has **no persistent disk** and wipes the ephemeral filesystem on every spin-down, so
a 4.6 GB file had nowhere to go and 512 MB of RAM to fail in. That was the "big downloads die
partway" bug.

v4 replaces it with [`SlidingWindowStore`](src/engine/window-store.js): an
`abstract-chunk-store` that holds ~64 MB of pieces in RAM, in LRU order, and drops the rest.
Nothing touches disk.

Forgetting is safe because of two things that reinforce each other:

1. **The route reads in windows.** `routes/stream.js` serves one ordinary full-length response,
   but internally reads it as a sequence of 16 MB `createReadStream` calls. webtorrent's
   `FileIterator` takes a stream selection over exactly the pieces a read covers and drops it
   when that read closes, and torrents are added with `deselect: true` so nothing else ever
   selects anything. The engine therefore cannot want more than 16 MB of pieces at a time —
   however large the file, and whatever the client asked for. Backpressure finishes the job: a
   slow client blocks the write and the swarm is never asked to run ahead.
2. **`get` touches a piece**, so whatever the current reader is reading is the most recently
   used and cannot be evicted by pieces arriving for its own window.

**This is invisible from outside.** v4.0 clamped every response to 16 MB and refused un-ranged
requests with 416, which meant a plain `<a download>` could not work and the browser needed a
service worker to stitch the slices back together. That put the memory bound in the protocol
where it did not belong. Responses are ordinary now.

When forgetting does bite — a seek backwards past the window — the read comes up short, the
route notices, resets the torrent to clear its bitfield, and the client retries. Slow,
correct, self-healing.

## The other idea: no state

Nothing is stored here. No database, no disk, no magnets, no progress — a spin-down or a
redeploy loses nothing because there was nothing to lose. v3's MongoDB and its Atlas
60-day idle-pause chore are gone.

Which raises the obvious problem: if the service forgets a torrent, how does it ever get it
back? **The download URL carries its own magnet.**

```
GET /torrent/<hash>/5?dl=1&t=<token>&m=magnet:?xt=urn:btih:<hash>&…
```

So the link is self-healing. If the box spun down, restarted or evicted the torrent for
capacity, the route re-adds it from the `m` parameter and carries on. Chrome's download manager
retries an interrupted download with `Range: bytes=N-` all by itself, which means **a native
download survives a server restart with no client-side code at all** — no service worker, no
retry loop, no JavaScript. That is the whole reason `Accept-Ranges` and a stable `ETag` are set
on every response.

## API

Everything except `/healthz` needs a token. `POST /session` trades the password for one.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/session` | `{ password }` → `{ token, expiresAt }`. HMAC-SHA256 over the expiry, keyed by `PASS`. 12 h. |
| `POST` | `/metadata` | `{ url: <magnet> }` → `{ infoHash, name, size, pieceLength, files[] }` |
| `GET` | `/torrent/:infoHash/:fileIndex` | The bytes, whole file or `Range`, nothing truncated. `?dl=1` for an attachment, `?m=<magnet>` to make the URL self-healing. |
| `GET` | `/stats/:infoHash` | SSE at 1 Hz: peers, speed, whether the torrent is still resident. |
| `GET` | `/healthz` | Unauthenticated. Counts, speeds, RSS, and each window's own bookkeeping. |

Tokens are accepted as `Authorization: Bearer …` **or** `?t=…`, because a `<video src>` and an
`EventSource` cannot set headers. That is also why they expire: a URL leaks in a way a header
does not. In v3 the stream URLs took no credential at all, so anyone with an infohash could
pull bytes against a 100 GB/month cap.

Errors are always `{ error: { code, message } }`. The codes the client branches on:

| code | status | meaning |
|---|---|---|
| `not_active` | 409 | re-`POST /metadata` and retry — expected, not a failure |
| `busy` | 409 | another file from this torrent is *actively* downloading — retry when it ends |
| `range_not_satisfiable` | 416 | the range starts past the end of the file |
| `at_capacity` | 409 | both slots are busy being read; nothing safe to evict |

## Quick start

```bash
cp .env.example .env      # set PASS
npm install
npm test                  # 36 tests, no network
npm run dev               # http://localhost:5000
```

```bash
TOK=$(curl -s localhost:5000/session -X POST -H 'content-type: application/json' \
  -d '{"password":"your-pass"}' | jq -r .token)

curl -s localhost:5000/metadata -X POST -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' -d '{"url":"magnet:?xt=urn:btih:..."}'

# The whole file, one request, bounded memory on the server side.
curl -s -H "authorization: Bearer $TOK" localhost:5000/torrent/<infoHash>/0 -o file.bin
```

## Deploy

**A box you own, via the `Dockerfile`.** This is the only supported deployment now: a service
behind an existing nginx, as one compose block with a `mem_limit` and one `location`. It buys a
disk, no 15-minute sleep, no monthly egress cap, and the ability to accept inbound peer
connections — see below for why that last one matters most.

Render is gone. `render.yaml` was deleted along with it; the free tier slept after 15 idle
minutes, capped egress at 100 GB a month, and a keep-warm ping to avoid the sleeping cost 730
of the 750 free hours. Measurements below that say "on Render" are kept because that is where
they were taken, not because it is still an option.

`fly.toml` is kept for self-hosting, but Fly replaced its free allowances with a 2-hour trial
in 2024 — only pre-2024 accounts still get free machines.

### Two things that will bite whoever containerises this next

**Use a glibc base image. Not alpine.** `node:24-alpine` builds, boots and answers `/healthz`
perfectly, then dies with `SIGSEGV` on the first `POST /metadata`. webtorrent's tree carries
native modules — `node-datachannel` (WebRTC, via `@thaunknown/simple-peer`) and `utp-native` —
and their prebuilds ship for `linux-x64` only, which means glibc. Loading one against musl does
not raise a readable error; it segfaults in a background thread, so the application log ends
mid-sentence, the container exits 139 and Docker restarts it. It reads as a mysterious clean
restart. `docker events` is what tells you the truth.

**Turn proxy buffering off.** A reverse proxy that buffers will spool a multi-gigabyte response
to its own disk, and — worse — will drain this service at full speed no matter what the browser
is doing. The one-reader-per-torrent handover decides a client has left by watching the
response stop draining, so a buffering proxy makes every cancelled download look alive and
leaves the torrent answering `busy`. In nginx that is `proxy_buffering off`,
`proxy_request_buffering off` and `proxy_max_temp_file_size 0`.

## Operational reality

Numbers measured on 2026-08-01, not estimated:

| | |
|---|---|
| Idle RSS | ~115 MB (91 MB on Render's Linux) |
| Read window | 16 MB |
| Store budget | 32 MB |
| A full 129 MB download | completed byte-exact, **475 window evictions** |
| Peak RSS during it, 64 MB budget | 233 MB — which is why the budget is now 32 MB |
| Peers per torrent | 100. At 30 the same download took 1.9x as long, for 15 MB less |

Other limits worth knowing:

- **One reader per torrent, and the window can be taken.** Two readers at different offsets
  would evict each other's pieces and both would crawl, so only one file per torrent downloads
  at a time. A newcomer takes the window from a read that is *not being used* — cancelled,
  socket gone, or nothing written for `STREAM_STALL_MS` — and gets `409 busy` from one that is
  actively writing bytes. Both halves matter: without the takeover a cancelled download made
  the torrent permanently busy; without the refusal two people would interrupt each other in
  turn and neither would finish. Pausing holds nothing — a resume is an ordinary `Range`
  request that takes the window if it happens to be free.
- **There is no zip-everything route, and it is not coming back on this host.** It shipped, it
  worked, and it was removed after Render reported the process exiting during a ~10 GB archive.
  Measured with a synthetic 6 GB archive and no swarm: the pipeline is genuinely bounded — RSS
  flat at 243 MB after the first 2 GB — but it *grows 168 MB* doing it. On top of ~91 MB idle,
  ~80 MB of peer buffers at 100 connections and the 32 MB window, that is ~370 MB before V8
  slack, on a box with 512 MB. Bounded is not the same as affordable. Save files one at a time.
- **No inbound peer connections.** Render exposes one HTTP port, so peers are outbound-only
  plus DHT. A swarm with only unconnectable peers will not work, and it is why raising
  `MAX_CONNS` past ~100 buys nothing: the reachable peers run out before the slots do.
- **A cold torrent is slow to start, and that is where the time goes.** Measured: the read path
  peaks near 7 MB/s, but the first minute crawls at tens of KB/s while DHT and the trackers find
  peers. Time-to-first-bytes, not throughput, is what makes a download feel slow.
- **The free tier sleeps** after 15 idle minutes and takes ~1 minute to wake. There is
  deliberately **no keep-warm ping**: v3's cost ~730 of the 750 free instance-hours a month,
  leaving no margin for one restart. An open download generates inbound traffic, so it cannot
  spin down mid-transfer.
- **100 GB/month of bandwidth.** Tokens limit exposure but are not a cap — a real monthly
  counter needs storage, and v4 deleted storage. `/healthz` reports bytes since boot; Render's
  dashboard is the authority.
- **Don't run a public instance.** Hosts terminate accounts over DMCA, and on a shared box
  that takes down everything else living on it.

## Why not rqbit

[rqbit](https://github.com/ikatson/rqbit) is the better engine — Rust, tens of MB of RAM, an
HTTP API with Range streaming and piece prioritisation, an official Docker image. It was the
first choice and it lost on one fact: its server offers filesystem and mmap storage only, with
no way to bound either, so a 4.6 GB file needs 4.6 GB of a disk Render does not provide. It
adds a second runtime without solving the binding constraint.

webtorrent is the scrappier engine, but it exposes `store`, `storeOpts` and `storeCacheSlots`
— which is the entire reason a bounded window is possible here. Revisit rqbit the day flai
moves to a box with a real disk.

## Layout

```
src/
├── server.js              express 5 bootstrap, lifecycle, error envelope
├── config.js              zod 4 env, and the comments explaining every number
├── logger.js              pino 10 + redaction
├── engine/
│   ├── index.js           add / get / reset, capacity 2, idle eviction
│   └── window-store.js    the store that forgets            ← read this one
├── routes/
│   ├── session.js         POST /session
│   ├── metadata.js        POST /metadata
│   ├── stream.js          GET /torrent/:hash/:idx           ← and this one
│   ├── stats.js           GET /stats/:hash (SSE)
│   └── health.js          GET /healthz
└── lib/
    ├── magnet.js          parseMagnet (40-hex + 32-base32), MIME table
    ├── range.js           parseRange
    ├── windowed.js        the bounded read both routes share
    ├── token.js           HMAC sign / verify, password check
    └── errors.js          HttpError + helpers
```

Design notes:
[docs/superpowers/specs/2026-08-01-flai-v4-design.md](docs/superpowers/specs/2026-08-01-flai-v4-design.md)

## Changed in v4

| | v3 | v4 |
|---|---|---|
| Chunk store | webtorrent default, unbounded | 64 MB LRU window, no disk |
| Reads | one stream over the whole file | 16 MB windows inside one full-length response |
| Piece selection | whole torrent, low priority | `deselect: true`; only an open stream selects |
| Max torrents | 8 | 2 |
| `maxConns` | 80 | 30 |
| Idle eviction | 15 min | 5 min |
| Auth | password in every request body | one `POST /session`, then a 12 h HMAC token |
| Stream URLs | **unauthenticated** | token-bearing, expiring |
| Progress | none | `GET /stats/:hash` over SSE |
| Storage | MongoDB, optional, could pause | none |
| Zip route | `archiver` over every file at once | removed — it defeated the window bound |
| Keep-warm | every 10 min, ~730 h/month | removed |
| Tests | none | 36, `node --test`, no network |
| express / zod / pino / webtorrent | 4 / 3 / 9 / 2.8 | 5 / 4 / 10 / 3.0 |
| Node | 20 (EOL 30 Apr 2026) | 24 LTS (to 30 Apr 2028) |

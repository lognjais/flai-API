# flai-api

A torrent-to-HTTP bridge that **forgets**. Paste a magnet, get an ordinary HTTP download —
of a 50 GB file, from a box with 512 MB of RAM and no disk at all.

```
flai/ (browser, GH Pages)  ──►  flai-api (Render free)  ──►  BitTorrent swarm
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
| `GET` | `/torrent/:infoHash` | Every file as one streamed zip. Same `?dl=1` and `?m=` . No `Content-Length` and no resume — see below. |
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
| `busy` | 409 | another reader holds this torrent's single window |
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

Render free, from `render.yaml`: Dashboard → New → Blueprint → pick this repo. Set `PASS` in
the dashboard (it is `sync: false`, so it never lives in git). Push to deploy.

`fly.toml` is kept for self-hosting, but Fly replaced its free allowances with a 2-hour trial
in 2024 — only pre-2024 accounts still get free machines.

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

- **One reader per torrent.** Two readers at different offsets would evict each other's pieces
  and both would crawl. A second distant reader gets `409 busy`. The zip counts as that one
  reader, so it costs no more memory than saving a single file does.
- **The zip has no `Content-Length` and cannot be resumed.** It is generated as it is sent, so
  its size is not known when the headers go out. Chrome shows an unknown size and, if the
  transfer breaks, starts over. Single files keep both. That is the price of one action instead
  of thirty, and the UI says so.
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
- **Don't run a public instance.** Render is quick to terminate accounts over DMCA.

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
│   ├── archive.js         GET /torrent/:hash — every file as one zip
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
| Zip route | `archiver` over every file at once | lazy windowed generators, one file in flight |
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

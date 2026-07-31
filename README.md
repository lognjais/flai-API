# flai-api

A torrent-to-HTTP bridge that **forgets**. Paste a magnet, get bounded `Range` slices over
HTTP — enough for a browser to download a 50 GB file, on a box with 512 MB of RAM and no disk
at all.

```
flai/ (browser, GH Pages)  ──►  flai-api (Render free)  ──►  BitTorrent swarm
   the download manager           a bounded byte pump
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

1. **Every response is clamped to `MAX_CHUNK_BYTES`.** webtorrent's `FileIterator` takes a
   stream selection over exactly the pieces a `createReadStream` covers and drops it when the
   stream closes. Torrents are added with `deselect: true`, so nothing else ever selects
   anything. Clamp the response and the engine *cannot* want more than one slice of pieces at
   a time. The clamp is the bound; the store budget is the safety net.
2. **`get` touches a piece**, so whatever the current reader is reading is the most recently
   used and cannot be evicted by pieces arriving for its own slice.

When forgetting does bite — a seek backwards past the window — the read comes up short, the
route notices, resets the torrent to clear its bitfield, and the client retries. Slow,
correct, self-healing.

## The other idea: no state

| State | Lives in |
|---|---|
| magnet + metadata | the browser's IndexedDB |
| which bytes are done | the browser's IndexedDB |
| where the file is saved | a `FileSystemFileHandle` in IndexedDB |
| **this service** | **nothing** |

So this service cannot resurrect a torrent it dropped — it never had the magnet. That is the
contract, not a gap:

```
client → GET /torrent/<hash>/0   Range: bytes=0-8388607
       ← 409 { code: "not_active" }
client → POST /metadata { url: <magnet it already had> }     (silent)
client → GET /torrent/<hash>/0   Range: bytes=0-8388607      (resumes)
```

A spin-down costs one silent round trip. There is no database to back up, migrate, or unpause
— v3's MongoDB and its Atlas 60-day idle-pause chore are gone.

## API

Everything except `/healthz` needs a token. `POST /session` trades the password for one.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/session` | `{ password }` → `{ token, expiresAt }`. HMAC-SHA256 over the expiry, keyed by `PASS`. 12 h. |
| `POST` | `/metadata` | `{ url: <magnet> }` → `{ infoHash, name, size, pieceLength, files[] }` |
| `GET` | `/torrent/:infoHash/:fileIndex` | The bytes. **`Range` required** above `MAX_CHUNK_BYTES`; every response is clamped to it. `?dl=1` for an attachment. |
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
| `range_required` | 416 | send a `Range`; this bridge never serves whole files |

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

# Range is not optional above 16 MB.
curl -s -H "authorization: Bearer $TOK" -H 'Range: bytes=0-8388607' \
  localhost:5000/torrent/<infoHash>/0 -o slice.bin
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
| Idle RSS | ~115 MB |
| Per active torrent | ~80 MB of peer buffers + its window |
| Default window | 64 MB |
| **Two torrents** | **~403 MB of 512 MB** |
| After serving 38 MB of a 129 MB file | RSS 145 MB, window holding 16.9 MB |

Other limits worth knowing:

- **One reader per torrent.** Two readers at different offsets would evict each other's pieces
  and both would crawl. A second distant reader gets `409 busy`.
- **No inbound peer connections.** Render exposes one HTTP port, so peers are outbound-only
  plus DHT. A swarm with only unconnectable peers will not work.
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
│   ├── stats.js           GET /stats/:hash (SSE)
│   └── health.js          GET /healthz
└── lib/
    ├── magnet.js          parseMagnet (40-hex + 32-base32), MIME table
    ├── range.js           parseRange + the clamp
    ├── token.js           HMAC sign / verify, password check
    └── errors.js          HttpError + helpers
```

Design notes:
[docs/superpowers/specs/2026-08-01-flai-v4-design.md](docs/superpowers/specs/2026-08-01-flai-v4-design.md)

## Changed in v4

| | v3 | v4 |
|---|---|---|
| Chunk store | webtorrent default, unbounded | 64 MB LRU window, no disk |
| Range responses | unbounded | clamped to 16 MB, `Range` required above that |
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

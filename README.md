# flai-api

Torrent-to-HTTP bridge. Paste a magnet, get HTTP streams with `Range` support — so a browser `<video>` can play and seek instantly while the swarm is still downloading.

```
flai/  (browser, GH Pages)  ──► flai-api  (Render free / Fly hobby)  ──► BitTorrent swarm
```

## Quick start (local)

```bash
cp .env.example .env       # set PASS=...
npm install
npm run dev                # http://localhost:5000
```

```bash
curl -X POST http://localhost:5000/metadata \
  -H 'Content-Type: application/json' \
  -d '{"password":"your-pass","url":"magnet:?xt=urn:btih:..."}'
```

## API

| Method | Path | Body / Params | Notes |
|---|---|---|---|
| `GET`  | `/healthz` | — | JSON status + engine stats. Used by Render/Fly health checks **and** the keep-warm pinger. |
| `POST` | `/metadata` | `{ url: <magnet>, password }` | Returns `{ infoHash, name, size, files[] }`. Cached — 2nd call is ~1ms. |
| `GET`  | `/torrent/:infoHash/:fileIndex` | `Range: bytes=...` | Streams the file. Supports HTTP `Range` (seeking). Add `?dl=1` for an attachment. |
| `GET`  | `/torrent/:infoHash` | — | Streams a `.zip` of all files. |
| `POST` | `/shorten` | `{ url, password }` | Stores a short id (Mongo or in-memory). |
| `GET`  | `/links/:id`, `/play/:id` | — | Proxies the stored URL through. |

All errors are `{ error: { code, message } }` JSON — no more redirect-to-error-page.

## Deploy — pick one

### A. Render Free (`render.yaml` included)

1. Connect this repo on https://dashboard.render.com → New → Blueprint.
2. Set these in the Render UI as secrets (sync: false):
   - `PASS`
   - `DATABASE` (optional — falls back to in-memory if unset; cache is **per-dyno**)
3. Render auto-detects `render.yaml`. Push → live.
4. Once deployed, set `PUBLIC_URL=https://<your-name>.onrender.com` so the keep-warm self-ping kicks in.

> **Render gotcha:** the free tier sleeps after 15 minutes idle. The keep-warm self-ping (every 10 min by default) keeps it warm — but burns ~700 hr/mo of your 750 hr free budget. If you want to use it for downloads only, set `KEEP_WARM_INTERVAL_MS=0` in Render env to disable.

### B. Fly.io (`fly.toml` included) — recommended for set-and-forget

```bash
brew install flyctl
fly auth login
fly launch --copy-config        # uses the existing fly.toml
fly secrets set PASS='...'
fly deploy
```

`fly.toml` has `auto_stop_machines = false` — the machine genuinely never sleeps. ~$0–5/mo, 160 GB egress free.

## Why this architecture

A pure browser BitTorrent client only sees WebRTC peers, which is a tiny subset of the real swarm (qBittorrent/Deluge ship libtorrent's WebTorrent support disabled). For most magnet links a browser-only client finds **zero peers**. This service runs a Node `webtorrent` instance — it speaks both TCP/uTP **and** WebRTC — and exposes its files over plain HTTP with `Range`. The browser just consumes that.

It is a torrent-to-HTTP bridge, not a torrent client.

## What got fixed (v3.0)

| Bug | What it broke | Fix |
|---|---|---|
| `parseMagnet` regex put 32-char alt before 40-char hex | 40-char hashes silently truncated → cache misses → "duplicate torrent" → torrent removed | Re-ordered alternation, matched 40-hex first; added base32→hex conversion |
| Two CORS middlewares emitted **two** `Access-Control-Allow-Origin` headers | Browsers reject the response | Single `cors()` with allowlist callback |
| `magnetCache` keyed by **filename** | Two torrents with same filename overwrote each other | Now keyed by **infohash** end-to-end |
| In-memory cache lost on Render's 15-min spindown | "Almost worked then 404'd" | Keep-warm self-ping + Fly.io option |
| API returned `302 → /#/error` instead of JSON | Frontend couldn't parse failure modes | Single error envelope `{ error: { code, message } }` |
| No `Range` support | Could not seek video | `parseRange()` + 206 responses |
| `process.on('uncaughtException')` swallowed errors | Hung dyno | Logs and exits, lets the platform restart |
| Plaintext password compare | Timing-side-channel | `timingSafeEqual` |
| No input validation | DoS / bad data crashes | `zod` schemas + 64 KB body limits + rate limit on writes |
| MongoDB hard-required | App crashed on connection failure | In-memory fallback so the core flow stays up |
| `setFileName.js` referenced undefined globals | Dead code | Replaced with proper MIME table |

## Project layout

```
src/
├── server.js              # Express bootstrap, lifecycle, error envelope
├── config.js              # zod-validated env
├── logger.js              # pino + redaction
├── db.js                  # Mongo + in-memory fallback
├── torrent-engine.js      # WebTorrent wrapper: infohash cache, TTL eviction, capacity
├── routes/
│   ├── metadata.js        # POST /metadata
│   ├── torrent.js         # GET /torrent/:hash/:idx (Range), GET /torrent/:hash (zip)
│   ├── links.js           # /shorten, /links/:id, /play/:id
│   └── health.js          # /healthz
└── lib/
    ├── magnet.js          # parseMagnet (40-hex + 32-base32), MIME map
    ├── auth.js            # constant-time password check
    ├── errors.js          # HttpError + helpers
    ├── keep-warm.js       # self-ping for Render
    └── makeid.js          # crypto-strong short ids
```

## Operational notes

- **Concurrency**: max 8 active torrents (`MAX_ACTIVE_TORRENTS`); LRU evicts when full and on 15-min idle.
- **Memory**: each active torrent ~50–150 MB while downloading. Render's 512 MB plan handles 2–3 concurrent torrents safely.
- **Streaming**: file streams hold a refcount; eviction skips torrents with active streams.
- **Trackers**: 6 UDP + 3 WSS announces on top of whatever the magnet carries; DHT enabled.
- **Legal**: don't deploy a public instance. Render and Fly are quick to terminate accounts on DMCA.

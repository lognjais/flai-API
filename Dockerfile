# flai-api as a container, for hosts that run several small services behind one
# front door — see the maia host repo.
#
# ── slim, NOT alpine, and this is load-bearing ────────────────────────────────
#
# The first version of this file used node:24-alpine, on the usual reasoning that
# pulls on a 1/8 OCPU box are slow. It built, started, answered /healthz, and then
# died with SIGSEGV the instant anything called POST /metadata.
#
# webtorrent's tree carries native modules — node-datachannel (WebRTC, via
# @thaunknown/simple-peer) and utp-native — and their prebuilt binaries ship for
# `linux-x64` only, meaning glibc. Alpine is musl. Loading a glibc .node against
# musl does not fail cleanly with a nice error; it segfaults, in a background
# thread, with nothing in the application log. The container just exits 139 and
# Docker restarts it, so it looks like a mysterious clean restart.
#
# Debian slim is glibc, which is also what Render ran, which is why this never
# showed up there. Do not "optimise" this back to alpine.
FROM node:24-slim

WORKDIR /app

# curl is here for the HEALTHCHECK below. Spawning a second Node runtime every
# minute to make one GET costs more than the service it is checking on a shared
# 1/8 OCPU box.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first, so a source change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Node's default heap on a small box is generous enough to be OOM-killed by the
# container limit before V8 ever decides to collect. The sliding window's bytes
# are Buffers, which live outside the heap, so the heap itself needs very little.
ENV NODE_OPTIONS=--max-old-space-size=192
ENV PORT=5000
EXPOSE 5000

# Not root, and not a user that has to be created — the node images ship one.
USER node

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5000/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]

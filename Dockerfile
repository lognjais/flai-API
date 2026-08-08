# flai-api as a container, for hosts that run several small services behind one
# front door — see the maia host repo.
#
# alpine because pulls on a 1/8 OCPU Always Free box are slow and the node:24
# Debian image is ~5x the size for nothing this needs.
FROM node:24-alpine

WORKDIR /app

# Dependencies first, so a source change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Node's default heap on a small box is generous enough to get OOM-killed by the
# container limit before V8 ever decides to collect. The sliding window's bytes
# are Buffers, which live outside the heap, so the heap itself needs very little.
ENV NODE_OPTIONS=--max-old-space-size=192
ENV PORT=5000
EXPOSE 5000

# Not root, and not a user that has to be created — node:alpine ships one.
USER node

# The bridge answers /healthz without touching the swarm, so this stays cheap.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]

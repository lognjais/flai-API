# Node 20 reached end of life on 30 April 2026, which is what this image used to pin.
# 24 is Active LTS until 30 April 2028.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN addgroup -g 1001 -S app && adduser -S app -u 1001 -G app
USER app

EXPOSE 5000
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/healthz || exit 1

CMD ["node", "src/server.js"]

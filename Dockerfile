# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vp build && npm prune --omit=dev --no-audit --no-fund && chmod -R a+rX,go-w /app

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    MINTLESS_DATA_DIR=/data \
    MINTLESS_HOST=0.0.0.0 \
    MINTLESS_PORT=3000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/web ./dist/web
COPY --from=build /app/db ./db
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/src/shared ./src/shared
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/server/main.ts"]

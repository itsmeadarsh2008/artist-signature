# Artist Signatures API — live Wikimedia lookup, no database files.
# Build:  docker build -t artist-signatures .
# Run:    docker run --rm -p 3000:3000 -e LIVE=on artist-signatures
# Lookup: curl "http://localhost:3000/v1/signatures?artist=Dua%20Lipa"
#
# Env knobs (see apps/api/src/index.ts): PORT, DB_PATH (default :memory:),
# ASSETS_DIR, PUBLIC_BASE_URL, CORS, LIVE. Mount a volume at /data and set
# DB_PATH=/data/signatures.sqlite to persist the cache across restarts.
FROM oven/bun:1.4.2 AS runner
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/importer/package.json apps/importer/
COPY packages/types/package.json packages/types/
COPY packages/parser/package.json packages/parser/
COPY packages/resolver/package.json packages/resolver/
COPY packages/database/package.json packages/database/
COPY packages/client/package.json packages/client/
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY apps/ apps/
COPY packages/ packages/
COPY migrations/ migrations/

ENV PORT=3000 \
    DB_PATH=:memory: \
    ASSETS_DIR=/data/assets \
    LIVE=on \
    CORS=true
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'const r = await fetch(`http://localhost:${process.env.PORT ?? 3000}/v1/health`); if (!r.ok) process.exit(1)'
CMD ["bun", "run", "apps/api/src/index.ts"]

# Artist Signatures — task runner.
# Needs `bun` (https://bun.sh) and `just` (https://just.systems).
# Recipe arguments are positional, e.g. `just api ./data/x.sqlite ./assets-x 3000`.

db := "./data/demo.sqlite"
assets := "./assets-demo"
port := "3499"
base_url := "http://localhost:" + port

default:
    @just --list

# Install dependencies.
install:
    bun install

# All unit + integration tests.
test:
    bun test

# Typecheck, no emit.
check:
    bun run check

# Apply pending migrations to a database file.
migrate db=db:
    bun run scripts/migrate.ts --db="{{ db }}"

# Seed a demo database + asset mirror (idempotent).
seed db=db assets=assets:
    bun examples/seed.ts --db="{{ db }}" --assets="{{ assets }}"

# Offline importer demo: real crawl + pipeline, stubbed network.
import-demo db=db assets=assets:
    bun examples/import-stubbed.ts --db="{{ db }}" --assets="{{ assets }}"

# Real Wikimedia crawl (resumable; re-runs pick up where they left off).
crawl db="./data/signatures.sqlite" assets="./assets" roots="Category:Signatures" depth="4" files="500" concurrency="4":
    bun run apps/importer/src/index.ts --db="{{ db }}" --assets="{{ assets }}" --roots="{{ roots }}" --max-depth={{ depth }} --max-files={{ files }} --concurrency={{ concurrency }}

# Serve the API (blocking).
api db=db assets=assets port=port:
    bun run apps/api/src/index.ts --db="{{ db }}" --assets="{{ assets }}" --port={{ port }} --public-base-url="http://localhost:{{ port }}"

# Serve the API with live Wikimedia lookup for uncrawled artists.
api-live db="./data/live.sqlite" assets=assets port=port:
    bun run apps/api/src/index.ts --db="{{ db }}" --assets="{{ assets }}" --port={{ port }} --public-base-url="http://localhost:{{ port }}" --live=on

# Serve the API with no database files at all: in-memory SQLite + live lookup.
# Nothing is written to disk; repeat lookups are cached for the process lifetime.
api-memory port=port:
    bun run apps/api/src/index.ts --db=":memory:" --assets=/tmp/no-assets --port={{ port }} --public-base-url="http://localhost:{{ port }}" --live=on

# Build the API container image (needs Docker).
docker-build tag="artist-signatures:latest":
    docker build -t {{ tag }} .

# Run the container: fileless live API on :3000. Override with -e, e.g.
# -e PORT=8080 -e DB_PATH=/data/signatures.sqlite (plus -v sigdata:/data).
docker-run tag="artist-signatures:latest" port="3000":
    docker run --rm -p {{ port }}:3000 -e LIVE=on {{ tag }}

# Serve examples/index.html (the browser lookup UI). Use with `just api`.
# Build the serverless browser bundle (fetch-only core, no SQLite).
# IIFE (not ESM): index.html loads it as a classic script for file:// use too.
build-web:
    mkdir -p examples/vendor
    bun build examples/direct-entry.ts --target=browser --format=iife --minify --outfile=examples/vendor/direct.bundle.js

web port="5173": build-web
    bunx --bun serve -p {{ port }} examples

# Remote client demo against a running API.
client-remote base_url=base_url:
    bun examples/client-remote.ts --base-url="{{ base_url }}"

# Offline client demo straight from a SQLite snapshot.
client-local db=db:
    bun examples/client-local.ts --db="{{ db }}"

# Publish a dataset snapshot (JSONL + SQLite file).
export db=db out="./dist/demo" base_url=base_url sqlite_out="./dist/demo.sqlite":
    bun run scripts/export.ts --db="{{ db }}" --out="{{ out }}" --public-base-url="{{ base_url }}" --sqlite-out="{{ sqlite_out }}"

# Full offline tour: seed -> stubbed import -> API -> both clients -> export.
demo db=db assets=assets port=port:
    #!/usr/bin/env bash
    set -euo pipefail
    just seed "{{ db }}" "{{ assets }}"
    just import-demo "{{ db }}" "{{ assets }}"
    bun run apps/api/src/index.ts --db="{{ db }}" --assets="{{ assets }}" --port={{ port }} --public-base-url="http://localhost:{{ port }}" &
    SRV=$!
    trap 'kill $SRV' EXIT
    sleep 1.5
    just client-remote "http://localhost:{{ port }}"
    just client-local "{{ db }}"
    just export "{{ db }}" ./dist/demo "http://localhost:{{ port }}" ./dist/demo.sqlite

# Remove demo artifacts (never touches ./data/signatures.sqlite).
clean-demo:
    rm -f ./data/demo.sqlite ./data/demo.sqlite-wal ./data/demo.sqlite-shm ./dist/demo.sqlite
    rm -rf ./assets-demo ./dist/demo

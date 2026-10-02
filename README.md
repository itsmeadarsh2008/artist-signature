# artist-signature
A not so simple API to retrieve artists' signatures.

Type an artist name, get their signature(s) — resolved to a MusicBrainz
identity, with the original license and Commons provenance on every record.
See [SPEC.md](SPEC.md) for the full design.

Three ways to retrieve, same shapes throughout:

| Mode | Command | Server | Database | Caching |
|---|---|---|---|---|
| API + SQLite | `just api` | yes | file | persistent |
| API, fileless | `just api-memory` | yes | `:memory:` | process lifetime |
| Direct | UI toggle / `ArtistSignatures.direct()` | no | none | none (live every call) |

## Quickstart

Prerequisites: [Bun](https://bun.sh/) 1.x and [just](https://just.systems/)
(`just --list` shows every recipe; recipe args are positional).

```bash
just install    # bun install
just web        # UI on http://localhost:5173 — Direct mode needs nothing else
```

Open http://localhost:5173 and search. For API-backed lookups, also run
`just api` (demo DB on :3499; `just seed` builds it) and switch the UI's
source selector. Or skip the UI:

```bash
curl "http://localhost:3499/v1/signatures?artist=Ada%20Melody"
```

No crawl needed for real artists — the API resolves uncrawled names live:

```bash
just api-live   # same API plus on-demand Wikimedia lookup (cached into the DB)
curl "http://localhost:3499/v1/signatures?artist=Dua%20Lipa"
```

No server at all — switch the UI's source selector to **Direct — no server**,
or in code:

```ts
import { ArtistSignatures } from "@artist-signatures/client";

const api = ArtistSignatures.direct(); // no baseUrl, no dataset file
const result = await api.signatures("Dua Lipa"); // live Commons + MusicBrainz
```

Direct mode does name lookups only (`signatures`, `getSignature`); `search`
and MBID lookup need the index a server or dataset file provides.

## API

All responses are `{ artist, signatures[] }` (or `{ matches[] }` when several
artists plausibly fit, never a silent wrong pick) and every error is
`{ error: { code, message } }`.

```text
GET /v1/signatures?artist=<name>&format=svg&type=handwritten&verified=true
GET /v1/name/<name>                    # same, for non-MusicBrainz consumers
GET /v1/artists/<musicbrainz-id>
GET /v1/signatures/<id>                # full metadata + provenance
GET /v1/search?q=<query>&limit=20&cursor=…
GET /v1/assets/…                       # mirrored files (immutable caching)
POST /v1/takedowns                     # { signatureId, reason, requester }
GET /admin/review/unresolved           # human review queue (no auth — see below)
```

Each signature carries `asset` (served mirror URL, else the upstream
`original_url`), `license` (`{ name, url, status }`, always the *original*
license), `source` (provider, Commons page, original URL), and a
`verification` state.

Search is scored, not just matched: exact name (100) → exact alias (90) →
prefix (80) → token-set in any order (70, so "Lipa Dua" works) → token
prefixes (60) → typo-tolerant fuzzy (≥30, so "Dua Lpia" works). Unrelated
names score 0 and never surface.

When an artist has several signatures, `best()` picks the one to render —
redistributable license first, then SVG format, verification state, match
confidence, and finally a panoramic-crop bonus (wide images are usually
complete signature lines; square canvases are often fragments) — instead of
whatever was imported first:

```ts
const top = await api.best("Dua Lipa"); // ranked pick
const first = await api.getSignature("Dua Lipa"); // first listed
```

## Web UI

`just web` serves `examples/index.html` (http://localhost:5173). Signatures
render white on a dark plate in any color scheme; the top-ranked card carries
a **Best pick** badge (same `best()` ranking as the client, computed in-page
for whatever transport served the results); clicking a signature — or
focusing it and pressing Enter — opens a zoomed view (Esc or backdrop click
closes it). Unservable assets degrade to a metadata-only placeholder instead
of a broken-image icon. Deep links work: `?q=Dua%20Lipa`,
`?mode=direct&q=Dua%20Lipa`.

## Layout

```text
apps/api/          Elysia REST API (SPEC §27-34, §43, §60) + live lookup
apps/importer/     Wikimedia crawler + import pipeline (SPEC §5, §23-26)
packages/types/    Shared domain types
packages/parser/   Commons extmetadata, wikitext and license parsing
packages/resolver/ Name normalization, confidence-scored resolution, search + signature ranking
packages/direct/   Fetch-only live core (server + browser share it)
packages/database/ Drizzle schema, queries, migrations runner (SQLite)
packages/client/   Remote, dataset-file, and direct client modes
migrations/        SQL migrations (drizzle-kit generated)
scripts/           migrate + dataset export (JSONL/SQLite)
examples/          Runnable demos, browser UI, serverless bundle entry
data/              Local SQLite files (gitignored via *.sqlite)
assets/            Mirrored signature files, content-addressed (gitignored)
Dockerfile         Fileless live API image (oven/bun)
justfile           Task runner (just --list)
```

## Development

```bash
just test       # 101 tests: unit + stubbed integration, no network needed
just check      # TypeScript, no emit
just demo       # full offline tour: seed → stubbed import → API → clients → export

just seed         # demo DB + asset mirror (idempotent)
just import-demo  # real crawl + pipeline, stubbed network
just client-remote / just client-local
just export       # JSONL + SQLite snapshot to ./dist

# Real Wikimedia crawl (resumable; re-runs pick up where they left off)
just crawl ./data/signatures.sqlite ./assets "Category:Signatures" 20 2000000 3
```

Conventions that matter: the importer never treats a filename as an identity
(every match carries a confidence score and method); unresolved signatures are
kept, not discarded; upstream deletions mark records `unavailable` instead of
deleting them; assets are mirrored only when the extracted license status is
`known`, otherwise the upstream `original_url` is served.

## Licensing

Split licensing:

- **Code** — MIT License ([LICENSE-MIT](LICENSE-MIT)): API server, importer,
  parser, resolver, database schema, client libraries.
- **Dataset curation** — CC BY 4.0 ([LICENSE-CC](LICENSE-CC)): schema, artist
  identity and resolution records, provenance links, published snapshots.
- **Signature assets and third-party metadata** — keep their original source
  licenses (CC0, CC BY, public domain…). They are **not** relicensed as MIT
  or CC BY; each record carries its own `license` + `source`, and the
  original source page is authoritative:

```json
{
  "license": { "name": "CC0 1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/" },
  "source": { "provider": "wikimedia_commons", "url": "https://commons.wikimedia.org/wiki/File:..." }
}
```

If you cannot determine the license for a given asset, assume all rights are
reserved and do not redistribute it.

## Hosting

The API is one Bun process with no required disk state. `Dockerfile` runs it
fileless (`DB_PATH=:memory:`, `LIVE=on`); configure with environment variables
(`PORT`, `DB_PATH`, `ASSETS_DIR`, `PUBLIC_BASE_URL`, `CORS`, `LIVE`) — CLI
flags (`--db=…` etc.) take precedence over env.

```bash
just docker-build
just docker-run                          # :3000, live lookup, nothing persisted
docker run --rm -p 3000:3000 \
  -e LIVE=on -e DB_PATH=/data/signatures.sqlite \
  -e PUBLIC_BASE_URL=https://<your-host> \
  -v sigdata:/data artist-signatures     # persisted cache across restarts
```

- Set `PUBLIC_BASE_URL` to your public origin, otherwise mirrored asset URLs
  point at localhost.
- No volumes are needed for fileless mode; add one only for a persistent
  `DB_PATH`. `HEALTHCHECK` hits `/v1/health`.
- The browser UI is static (`examples/index.html`) — host it anywhere and
  point it at the API via its API field or `?api=`. In Direct mode it needs
  no API at all (shareable as `?mode=direct&q=Dua%20Lipa`).

## Netlify (static UI)

`netlify.toml` is ready: connect the repo, and Netlify builds the serverless
bundle and publishes `examples/` — no API server involved.

```bash
# Equivalent of what Netlify runs on every push:
rm -rf examples/vendor && just build-web
```

What you get is the full UI in Direct mode (live Commons + MusicBrainz
straight from the browser). To also serve API-backed lookups, deploy the
`Dockerfile` to Fly.io/Render/Railway and set the UI's API field (or `?api=`)
to that origin — the API reflects CORS origins by default, so no extra
config is needed. The API itself cannot run on Netlify Functions (Node/Lambda
runtime: no Bun, no `bun:sqlite`, no long-lived process).
- `/admin/*` has no authentication: keep it off the public internet or gate
  it at the proxy (basic auth / IP allowlist) before exposing the container.

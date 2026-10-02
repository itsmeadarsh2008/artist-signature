# artist-signature
A not so simple API to retrieve artists' signatures

See [SPEC.md](SPEC.md) for the full design.

## Layout

```text
apps/api/          Elysia REST API (SPEC §27-34, §43, §60)
apps/importer/     Wikimedia crawler + import pipeline (SPEC §5, §23-26)
packages/types/    Shared domain types
packages/parser/   Commons extmetadata + wikitext + license parsing
packages/resolver/ Name normalization + artist scoring
packages/database/ Drizzle schema, queries, migrations runner (SQLite)
packages/client/   Remote + offline (`fromDataset`) client library
migrations/        SQL migrations (drizzle-kit generated)
scripts/           migrate + dataset export (JSONL/SQLite)
data/              Local SQLite files (gitignored via *.sqlite)
assets/            Mirrored signature files, content-addressed (gitignored)
```

## Licensing

This project uses split licensing:

- **Code** — MIT License. See [LICENSE-MIT](LICENSE-MIT). This covers the API
  server, importer, parser, resolver, database schema, and client libraries.
- **Dataset** — CC BY 4.0 for the original curation work. See
  [LICENSE-CC](LICENSE-CC). This covers the schema, artist identity and
  resolution records, provenance links, and dataset snapshots published by
  this project.
- **Signature assets and third-party metadata** — licensed according to their
  respective source licenses (e.g. CC0, CC BY, public domain). These are
  **not** relicensed as MIT or CC BY. Every record carries its own `license`
  and `source` metadata, and the original source page remains the
  authoritative license record.

```json
{
  "license": {
    "name": "CC0 1.0",
    "url": "https://creativecommons.org/publicdomain/zero/1.0/"
  },
  "source": {
    "provider": "wikimedia_commons",
    "url": "https://commons.wikimedia.org/wiki/File:..."
  }
}
```

If you cannot determine the license for a given asset, assume all rights are
reserved and do not redistribute it.

## Development

Prerequisites: [Bun](https://bun.sh/) 1.x and [just](https://just.systems/).
PostgreSQL is the recommended production backend (SPEC §22); the current
implementation runs on SQLite via `bun:sqlite`, which needs no server.

```bash
just install    # bun install
just test       # all unit + integration tests
just check      # TypeScript, no emit

# Full offline tour: seed -> stubbed import -> API -> both clients -> export
just demo

# Individual steps (recipe args are positional: `just api <db> <assets> <port>`)
just seed         # demo DB + asset mirror (idempotent)
just import-demo  # real crawl + pipeline, stubbed network (no Wikimedia access)
just api          # serve the API (blocking)
just client-remote
just client-local
just export

# Real Wikimedia crawl (resumable; re-runs pick up where they left off)
just crawl ./data/signatures.sqlite ./assets "Category:Signatures" 20 2000000 3

# Live lookup: uncrawled artists resolve against Wikimedia on demand and are
# cached into the DB (metadata-only, no downloads). Seed lists are still the
# bulk path; this covers the long tail.
just api-live
curl "http://localhost:3499/v1/signatures?artist=Dua%20Lipa"

# No database at all: in-memory SQLite + live lookup. Nothing is written to
# disk; repeats are cached for the process lifetime, restarts re-fetch (~3s).
just api-memory
curl "http://localhost:3499/v1/signatures?artist=Ed%20Sheeran"

# Browser UI (needs the API running; defaults to localhost:3499)
just web          # open http://localhost:5173
```

Runnable scripts live in [`examples/`](examples/) — start with
`examples/seed.ts`, then `examples/client-remote.ts` /
`examples/client-local.ts` against the demo database.

Quick client usage (SPEC §35-37):

```ts
import { ArtistSignatures } from "@artist-signatures/client";

const api = new ArtistSignatures({ baseUrl: "http://localhost:3000" });
const result = await api.signatures("Dua Lipa");
console.log(result.signatures);

// Offline, from a published snapshot:
const db = await ArtistSignatures.fromDataset("./signatures.sqlite");
const same = await db.signatures("Dua Lipa");
```

Notes:

- `/admin/*` has no authentication yet — keep it off the public internet or
  put it behind auth before deploying.
- Only files whose extracted license status is `known` are mirrored into
  `assets/`; everything else keeps metadata + provenance with a fallback to
  the upstream original URL.

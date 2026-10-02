/**
 * Public REST API (SPEC §27-34, §43, §60).
 *
 * Predictable responses (SPEC §44) — consumers never see Wikimedia shapes.
 * Every error uses {error:{code, message}} (SPEC §47). Input is validated
 * and bounded (SPEC §48); public endpoints are rate-limited per IP.
 *
 * NOTE: /admin/* has no auth in this MVP. Put it behind authentication
 * (or a private network) before any public deployment.
 */

import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { sql } from "drizzle-orm";
import {
  applyTakedown,
  approveResolution,
  createDb,
  findArtistByMbid,
  findArtistByNormalized,
  getSignatureFull,
  listPendingResolutions,
  listPendingUnresolved,
  listSignaturesForArtist,
  migrateToLatest,
  searchArtists,
  setSignatureStatus,
  type ArtistRow,
  type Db,
  type FullSignature,
} from "@artist-signatures/database";
import { normalizeName } from "@artist-signatures/resolver";
import { importLiveSignatures, type LiveLookupDeps } from "./live";

export interface ApiConfig {
  db: Db;
  assetDir: string;
  /** e.g. "https://cdn.example.com" — prefixed onto mirrored asset paths. */
  publicBaseUrl: string;
  rateLimitPerMinute?: number;
  /**
   * Extra browser origins allowed to call the API (e.g. the examples page).
   * Defaults to none beyond same-origin; "true" reflects the request origin.
   */
  corsOrigins?: string[] | true;
  /**
   * On-demand Wikimedia lookup for names missing from the database.
   * Off by default; see `live` in the CLI (SPEC §12).
   */
  live?: false | LiveLookupDeps;
}

const MAX_LIMIT = 100;
const MAX_QUERY_LEN = 200;
const FORMATS = new Set(["svg", "png", "jpeg", "webp", "other"]);
const TYPES = new Set(["handwritten", "autograph", "digital", "monogram", "initials", "unknown"]);

const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function err(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function parseLimit(value: string | null): number | Response {
  const n = value === null ? 20 : parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return err("INVALID_REQUEST", `limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
  }
  return n;
}

function artistJson(a: ArtistRow) {
  return {
    id: a.id,
    name: a.name,
    musicbrainz_id: a.musicbrainzId,
    wikidata_id: a.wikidataId,
  };
}

function signatureJson(full: FullSignature, publicBaseUrl: string) {
  const s = full.signature;
  const license = full.licenses[0];
  const source = full.sources[0];
  const mirrorUrl = s.assetUrl ? `${publicBaseUrl.replace(/\/$/, "")}/v1/assets/${s.assetUrl}` : undefined;
  return {
    id: s.id,
    artist: full.artist
      ? { name: full.artist.name, musicbrainz_id: full.artist.musicbrainzId, wikidata_id: full.artist.wikidataId }
      : null,
    asset: {
      url: mirrorUrl ?? source?.originalUrl ?? undefined,
      format: s.format,
      type: s.type,
      width: s.width,
      height: s.height,
      sha256: s.sha256,
    },
    source: source
      ? { provider: source.provider, url: source.sourceUrl, original_url: source.originalUrl }
      : null,
    license: license
      ? { name: license.name, url: license.url, status: license.status }
      : { name: "Unknown", url: undefined, status: "unknown" },
    verification: s.verification,
  };
}

export function createApp(config: ApiConfig) {
  const { db, assetDir, publicBaseUrl } = config;
  const rateLimit = config.rateLimitPerMinute ?? 600;
  const hits = new Map<string, { count: number; reset: number }>();

  const app = new Elysia()
    .use(
      cors({
        origin: config.corsOrigins ?? false,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["content-type"],
      }),
    )
    .onRequest(({ request }) => {
      // SPEC §48: rate-limit public endpoints (fixed window per client IP).
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
      const now = Date.now();
      const slot = hits.get(ip);
      if (!slot || slot.reset <= now) {
        hits.set(ip, { count: 1, reset: now + 60_000 });
        return;
      }
      slot.count++;
      if (slot.count > rateLimit) {
        return err("RATE_LIMITED", "Rate limit exceeded. Slow down and retry.", 429);
      }
    })
    .get("/v1/health", () => ({ status: "ok" }))

    // SPEC §27/§29: the simple case — a name in, signatures out.
    .get("/v1/signatures", async ({ query }) => {
      const raw = typeof query.artist === "string" ? query.artist : "";
      if (raw.trim() === "" || raw.length > MAX_QUERY_LEN) {
        return err("INVALID_REQUEST", "Query parameter 'artist' is required (max 200 chars).", 400);
      }
      let artist = findArtistByNormalized(db, normalizeName(raw));
      if (!artist && config.live) {
        await tryLive(db, config.live, raw);
        artist = findArtistByNormalized(db, normalizeName(raw));
      }
      if (!artist) {
        // SPEC §61: plausible candidates instead of a silent wrong pick.
        const { results } = searchArtists(db, raw, normalizeName, 5);
        if (results.length > 0) {
          return {
            matches: results.map((r) => ({ name: r.artist.name, musicbrainz_id: r.artist.musicbrainzId, signature_count: r.signatureCount })),
          };
        }
        return err("ARTIST_NOT_FOUND", "No artist was found for the supplied name.", 404);
      }
      const filters = signatureFilters(query);
      if (filters instanceof Response) return filters;
      const limit = parseLimit(typeof query.limit === "string" ? query.limit : null);
      if (limit instanceof Response) return limit;
      const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
      const page = listSignaturesForArtist(db, artist.id, filters, limit, cursor);
      return {
        artist: artistJson(artist),
        signatures: page.items.map((s) => signatureJson(s, publicBaseUrl)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    })

    // SPEC §29 alias of the above for non-MusicBrainz consumers.
    .get("/v1/name/:name", async ({ params, query }) => {
      const name = decodeURIComponent(params.name);
      if (name.length > MAX_QUERY_LEN) return err("INVALID_REQUEST", "Name too long (max 200 chars).", 400);
      let artist = findArtistByNormalized(db, normalizeName(name));
      if (!artist && config.live) {
        await tryLive(db, config.live, name);
        artist = findArtistByNormalized(db, normalizeName(name));
      }
      if (!artist) {
        const { results } = searchArtists(db, name, normalizeName, 5);
        if (results.length > 0) {
          return {
            matches: results.map((r) => ({ name: r.artist.name, musicbrainz_id: r.artist.musicbrainzId, signature_count: r.signatureCount })),
          };
        }
        return err("ARTIST_NOT_FOUND", "No artist was found for the supplied name.", 404);
      }
      const filters = signatureFilters(query as Record<string, unknown>);
      if (filters instanceof Response) return filters;
      const limit = parseLimit(typeof (query as Record<string, unknown>).limit === "string" ? ((query as Record<string, unknown>).limit as string) : null);
      if (limit instanceof Response) return limit;
      const cursor = typeof (query as Record<string, unknown>).cursor === "string" ? ((query as Record<string, unknown>).cursor as string) : undefined;
      const page = listSignaturesForArtist(db, artist.id, filters, limit, cursor);
      return {
        artist: artistJson(artist),
        signatures: page.items.map((s) => signatureJson(s, publicBaseUrl)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    })

    // SPEC §28.
    .get("/v1/artists/:mbid", ({ params, query }) => {
      const artist = findArtistByMbid(db, params.mbid);
      if (!artist) return err("ARTIST_NOT_FOUND", "No artist was found for the supplied MusicBrainz ID.", 404);
      const limit = parseLimit(typeof query.limit === "string" ? query.limit : null);
      if (limit instanceof Response) return limit;
      const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
      const page = listSignaturesForArtist(db, artist.id, {}, limit, cursor);
      return {
        ...artistJson(artist),
        aliases: dbAliases(db, artist.id),
        signatures: page.items.map((s) => signatureJson(s, publicBaseUrl)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    })

    // SPEC §30.
    .get("/v1/signatures/:id", ({ params }) => {
      const full = getSignatureFull(db, params.id);
      if (!full) return err("SIGNATURE_NOT_FOUND", "No signature was found for the supplied ID.", 404);
      return signatureJson(full, publicBaseUrl);
    })

    // SPEC §31/§33.
    .get("/v1/search", ({ query }) => {
      const q = typeof query.q === "string" ? query.q : "";
      if (q.trim() === "" || q.length > MAX_QUERY_LEN) {
        return err("INVALID_REQUEST", "Query parameter 'q' is required (max 200 chars).", 400);
      }
      const limit = parseLimit(typeof query.limit === "string" ? query.limit : null);
      if (limit instanceof Response) return limit;
      const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
      const { results, nextCursor } = searchArtists(db, q, normalizeName, limit, cursor);
      return {
        results: results.map((r) => ({ type: "artist", id: r.artist.id, name: r.artist.name, musicbrainz_id: r.artist.musicbrainzId, signature_count: r.signatureCount })),
        ...(nextCursor ? { nextCursor } : {}),
      };
    })

    // Mirrored assets. Served for <img> embedding, never inlined (SPEC §49).
    .get("/v1/assets/*", ({ params }) => {
      const rel = String((params as Record<string, string>)["*"] ?? "");
      const full = resolve(assetDir, normalize(rel));
      if (!full.startsWith(resolve(assetDir) + "/") || !existsSync(full)) {
        return err("SIGNATURE_NOT_FOUND", "No asset was found for the supplied path.", 404);
      }
      const ext = full.slice(full.lastIndexOf(".")).toLowerCase();
      return new Response(Bun.file(full), { headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" } });
    })

    // SPEC §43.
    .post("/v1/takedowns", async ({ request }) => {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return err("INVALID_REQUEST", "Request body must be JSON.", 400);
      }
      const signatureId = body.signatureId;
      const reason = body.reason;
      const requester = body.requester;
      if (typeof signatureId !== "string" || typeof reason !== "string" || typeof requester !== "string" ||
        signatureId === "" || reason === "" || requester === "" ||
        signatureId.length > 200 || reason.length > 2000 || requester.length > 200) {
        return err("INVALID_REQUEST", "Fields 'signatureId', 'reason', 'requester' are required with sane lengths.", 400);
      }
      try {
        const id = applyTakedown(db, {
          signatureId,
          source: typeof body.source === "string" ? body.source : undefined,
          reason,
          requester,
          contact: typeof body.contact === "string" ? body.contact : undefined,
        });
        return Response.json({ id, signature_id: signatureId, status: "open" }, { status: 201 });
      } catch {
        return err("SIGNATURE_NOT_FOUND", "No signature was found for the supplied ID.", 404);
      }
    })

    // SPEC §60 review queue.
    .get("/admin/review/unresolved", ({ query }) => {
      const limit = parseLimit(typeof query.limit === "string" ? query.limit : null);
      if (limit instanceof Response) return limit;
      return {
        resolutions: listPendingResolutions(db, limit).map((p) => ({
          resolution: { id: p.resolution.id, method: p.resolution.method, confidence: p.resolution.confidence, raw_name: p.resolution.rawName },
          signature: signatureJson({ signature: p.signature, artist: p.artist, sources: [], licenses: [], resolutions: [] }, publicBaseUrl),
          artist: p.artist ? artistJson(p.artist) : null,
        })),
        unresolved: listPendingUnresolved(db, limit),
      };
    })
    .post("/admin/review/:id/approve", ({ params }) => {
      try {
        approveResolution(db, params.id);
        return { ok: true };
      } catch {
        return err("RESOLUTION_NOT_FOUND", "No resolution was found for the supplied ID.", 404);
      }
    })
    .post("/admin/signatures/:id/status", async ({ params, request }) => {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return err("INVALID_REQUEST", "Request body must be JSON.", 400);
      }
      const status = body.status;
      if (status !== "available" && status !== "unavailable") {
        return err("INVALID_REQUEST", "Field 'status' must be 'available' or 'unavailable'.", 400);
      }
      const full = getSignatureFull(db, params.id);
      if (!full) return err("SIGNATURE_NOT_FOUND", "No signature was found for the supplied ID.", 404);
      setSignatureStatus(
        db,
        params.id,
        status,
        typeof body.action === "string" ? body.action : status === "available" ? "restore" : "remove",
        typeof body.actor === "string" ? body.actor : "admin",
        typeof body.reason === "string" ? body.reason : undefined,
      );
      return { ok: true };
    });

  return app;
}

function signatureFilters(query: Record<string, unknown>) {
  const format = typeof query.format === "string" ? query.format : undefined;
  const type = typeof query.type === "string" ? query.type : undefined;
  if (format !== undefined && !FORMATS.has(format)) {
    return err("INVALID_FORMAT", `Unknown format '${format}'. Expected one of: ${[...FORMATS].join(", ")}.`, 400);
  }
  if (type !== undefined && !TYPES.has(type)) {
    return err("INVALID_FORMAT", `Unknown type '${type}'. Expected one of: ${[...TYPES].join(", ")}.`, 400);
  }
  return {
    ...(format ? { format } : {}),
    ...(type ? { type } : {}),
    ...(typeof query.license === "string" ? { license: query.license } : {}),
    ...(typeof query.source === "string" ? { source: query.source } : {}),
    ...(query.verified === "true" ? { verifiedOnly: true } : {}),
  };
}

/**
 * On-demand lookup. Any failure (network, upstream outage, ambiguous name)
 * leaves the database untouched and the request falls through to the normal
 * not-found path — live search must never turn a 404 into a 500.
 */
async function tryLive(db: Db, deps: LiveLookupDeps, name: string): Promise<void> {
  try {
    await importLiveSignatures(db, name, deps);
  } catch (err) {
    console.error(`live lookup failed for "${name}":`, err instanceof Error ? err.message : err);
  }
}

// Aliases live beside artists; tiny helper to keep handlers readable.
function dbAliases(db: Db, artistId: string): string[] {
  return db.all<{ alias: string }>(sql`SELECT alias FROM artist_aliases WHERE artist_id = ${artistId};`).map((r) => r.alias);
}

// Standalone server: bun run apps/api/src/index.ts --db=... --port=3000 --assets=... --public-base-url=...
if (import.meta.main) {
  // CLI flags win; environment variables (DB_PATH, PORT, ASSETS_DIR,
  // PUBLIC_BASE_URL, CORS, LIVE) are the fallback so container hosts that
  // only inject env can configure the server without flags.
  const arg = (name: string, env: string, fallback: string): string => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    return process.env[env] ?? fallback;
  };
  const dbPath = arg("db", "DB_PATH", "./data/signatures.sqlite");
  const port = parseInt(arg("port", "PORT", "3000"), 10);
  const assetDir = arg("assets", "ASSETS_DIR", "./assets");
  const publicBaseUrl = arg("public-base-url", "PUBLIC_BASE_URL", `http://localhost:${port}`);
  // Comma-separated allowlist; "true" reflects the request origin.
  const corsArg = arg("cors", "CORS", "true");
  // "live" enables on-demand Wikimedia lookup for uncrawled artists.
  const liveArg = arg("live", "LIVE", "off");
  const { db } = createDb(dbPath);
  const applied = migrateToLatest(db, join(import.meta.dir, "../../../migrations"));
  if (applied.length > 0) console.log(`applied migrations: ${applied.join(", ")}`);
  createApp({
    db,
    assetDir,
    publicBaseUrl,
    corsOrigins: corsArg === "true" ? true : corsArg.split(",").map((s) => s.trim()).filter(Boolean),
    live: liveArg === "on" ? {} : false,
  }).listen(port);
  console.log(`listening on :${port}`);
}

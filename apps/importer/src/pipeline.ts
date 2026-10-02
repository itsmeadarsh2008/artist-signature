/**
 * Per-file import pipeline (SPEC §23, §58).
 *
 * DISCOVERED -> METADATA_FETCHED -> PARSED -> RESOLVED -> LICENSE_CHECKED
 * -> DOWNLOADED -> HASHED -> DEDUPLICATED -> IMPORTED, FAILED on error.
 * Retryable failures return to a retryable state via the attempts counter;
 * files failing 3 times are left FAILED (dead-letter, never retried blindly).
 *
 * Asset policy: files are mirrored locally ONLY when the extracted license
 * status is `known`. Otherwise metadata + provenance are preserved with
 * assetUrl null and the API falls back to the upstream original_url.
 * Assets are treated as untrusted input (SPEC §48-49): size caps,
 * Content-Type checks, and magic-byte validation before anything touches disk.
 * SVGs are served via `<img>`, never inlined (SPEC §49).
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { parseCommonsFile, type ParsedCommonsFile } from "@artist-signatures/parser";
import {
  failImportItem,
  findSourcesByTitle,
  getImportItem,
  getSignatureFull,
  insertSignatureFull,
  insertUnresolved,
  setSignatureStatus,
  upsertArtist,
  upsertImportItem,
  type Db,
} from "@artist-signatures/database";
import { normalizeName, resolveArtist, type KnownArtist } from "@artist-signatures/resolver";
import type { CommonsClient } from "./wikimedia";
import { searchMusicBrainzArtist } from "./musicbrainz";
import { fetchWikidataEntity } from "./wikidata";

export const MAX_ATTEMPTS = 3;

export interface PipelineDeps {
  client: CommonsClient;
  assetDir: string;
  downloadBytes?: (url: string) => Promise<{ bytes: Uint8Array; contentType?: string }>;
  lookupMusicBrainz?: (name: string) => Promise<{ id: string; name: string; sortName?: string; aliases?: string[] } | undefined>;
  fetchWikidata?: (qid: string) => Promise<{ qid: string; label?: string; aliases: string[]; musicbrainzId?: string } | undefined>;
  maxAssetBytes?: number;
  acceptThreshold?: number;
  reviewThreshold?: number;
}

export type FileOutcome = "imported" | "unresolved" | "skipped" | "failed";

export interface KnownArtists {
  list: KnownArtist[];
  byId: Map<string, KnownArtist>;
}

/** Snapshot of all known artists for in-memory resolution during a run. */
export function buildKnownArtists(db: Db): KnownArtists {
  const rows = db.all<{
    id: string; name: string; sortName: string | null; musicbrainzId: string | null; wikidataId: string | null; alias: string | null;
  }>(sql`SELECT a.id, a.name, a.sort_name AS sortName, a.musicbrainz_id AS musicbrainzId,
    a.wikidata_id AS wikidataId, al.alias AS alias
    FROM artists a LEFT JOIN artist_aliases al ON al.artist_id = a.id;`);
  const byId = new Map<string, KnownArtist>();
  for (const r of rows) {
    let artist = byId.get(r.id);
    if (!artist) {
      artist = { id: r.id, name: r.name, sortName: r.sortName ?? undefined, musicbrainzId: r.musicbrainzId ?? undefined, wikidataId: r.wikidataId ?? undefined, aliases: [] };
      byId.set(r.id, artist);
    }
    if (r.alias) artist.aliases!.push(r.alias);
  }
  return { list: [...byId.values()], byId };
}

function trackKnown(
  known: KnownArtists,
  artist: { id: string; name: string; sortName?: string | null; musicbrainzId?: string | null; wikidataId?: string | null },
  aliases: string[] = [],
): void {
  const entry: KnownArtist = {
    id: artist.id,
    name: artist.name,
    sortName: artist.sortName ?? undefined,
    musicbrainzId: artist.musicbrainzId ?? undefined,
    wikidataId: artist.wikidataId ?? undefined,
    aliases,
  };
  known.list.push(entry);
  known.byId.set(artist.id, entry);
}

// ---------------------------------------------------------------------------
// Asset validation (SPEC §49)
// ---------------------------------------------------------------------------

export class AssetError extends Error {}

const ALLOWED_TYPES: Record<string, { ext: string; format: "svg" | "png" | "jpeg" | "webp" | "gif" }> = {
  "image/svg+xml": { ext: "svg", format: "svg" },
  "image/png": { ext: "png", format: "png" },
  "image/jpeg": { ext: "jpeg", format: "jpeg" },
  "image/webp": { ext: "webp", format: "webp" },
  "image/gif": { ext: "gif", format: "gif" },
};

function magicFormat(bytes: Uint8Array): keyof typeof EXT_BY_MAGIC | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  return undefined;
}

const EXT_BY_MAGIC = { png: "png", jpeg: "jpeg", webp: "webp", gif: "gif" } as const;

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.slice(0, 4096)).toString("utf8").replace(/^﻿/, "").trimStart();
  return head.startsWith("<") && /<svg[\s>]|<svg$/i.test(head.slice(0, 4096));
}

/**
 * Throws AssetError when untrusted bytes fail validation.
 * Returns the storage extension + normalized signature format.
 */
export function validateAsset(bytes: Uint8Array, contentType: string | undefined, maxBytes: number): { ext: string; format: string } {
  if (bytes.length === 0) throw new AssetError("empty asset");
  if (bytes.length > maxBytes) throw new AssetError(`asset too large: ${bytes.length} bytes`);
  const magic = magicFormat(bytes);
  if (magic) return { ext: EXT_BY_MAGIC[magic], format: magic === "gif" ? "other" : magic };
  if (looksLikeSvg(bytes)) {
    if (contentType && contentType.split(";")[0].trim() !== "image/svg+xml") {
      throw new AssetError(`content-type ${contentType} does not match SVG bytes`);
    }
    return { ext: "svg", format: "svg" };
  }
  if (contentType) {
    const known = ALLOWED_TYPES[contentType.split(";")[0].trim()];
    if (!known) throw new AssetError(`disallowed content-type: ${contentType}`);
  }
  throw new AssetError("unrecognized file signature");
}

/** Metadata-based signature-type classification (SPEC §18, no computer vision). */
export function classifyType(parsed: ParsedCommonsFile): string {
  const hay = `${parsed.title} ${parsed.description ?? ""} ${parsed.categories.join(" ")}`.toLowerCase();
  if (/monogram/.test(hay)) return "monogram";
  if (/initials?/.test(hay)) return "initials";
  if (/digital/.test(hay)) return "digital";
  if (/autograph/.test(hay)) return "autograph";
  if (/signature/.test(hay)) return "handwritten";
  return "unknown";
}

async function defaultDownload(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType?: string }> {
  const res = await fetch(url, { headers: { "User-Agent": "ArtistSignatures/1.0 (dataset importer)" } });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const announced = res.headers.get("content-length");
  if (announced && parseInt(announced, 10) > maxBytes) throw new AssetError(`announced size exceeds cap`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get("content-type") ?? undefined };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function processDiscoveredFile(db: Db, deps: PipelineDeps, sourceTitle: string, known: KnownArtists): Promise<FileOutcome> {
  const maxBytes = deps.maxAssetBytes ?? 10_000_000;
  const acceptThreshold = deps.acceptThreshold ?? 0.9;
  const reviewThreshold = deps.reviewThreshold ?? 0.7;

  const item = getImportItem(db, sourceTitle);
  if (item?.state === "IMPORTED") return "skipped";
  if (item?.state === "FAILED" && item.attempts >= MAX_ATTEMPTS) return "skipped";

  try {
    const [meta] = await deps.client.fetchFileMetadata([sourceTitle]);
    if (!meta) {
      handleUpstreamDelete(db, sourceTitle);
      upsertImportItem(db, sourceTitle, "IMPORTED");
      return "skipped";
    }
    // SPEC §25 incremental update: same upstream revision -> nothing to do.
    if (meta.revid !== undefined) {
      const prior = findSourcesByTitle(db, "wikimedia_commons", sourceTitle);
      if (prior.some((s) => s.revisionId === String(meta.revid))) {
        upsertImportItem(db, sourceTitle, "IMPORTED");
        return "skipped";
      }
    }
    upsertImportItem(db, sourceTitle, "METADATA_FETCHED");
    const parsed = parseCommonsFile(meta);
    upsertImportItem(db, sourceTitle, "PARSED");

    const resolution = await resolveToArtist(db, deps, parsed, known, acceptThreshold, reviewThreshold);
    upsertImportItem(db, sourceTitle, "RESOLVED");
    upsertImportItem(db, sourceTitle, "LICENSE_CHECKED");

    if (!resolution.artistId) {
      insertUnresolved(db, {
        rawTitle: parsed.title,
        description: parsed.description,
        categories: parsed.categories,
        wikidataId: parsed.wikidataId,
        candidates: resolution.candidates.map((c) => ({ name: c.artist.name, musicbrainzId: c.artist.musicbrainzId, confidence: c.confidence, method: c.method })),
        confidence: resolution.candidates[0]?.confidence,
        pageUrl: parsed.sourceUrl,
        originalUrl: parsed.originalUrl,
      });
      upsertImportItem(db, sourceTitle, "IMPORTED");
      return "unresolved";
    }

    // Mirror only known-free licenses; provenance is always preserved.
    let assetUrl: string | undefined;
    let format = "other";
    let sha256: string | undefined;
    if (parsed.license.status === "known" && parsed.originalUrl) {
      try {
        const dl = deps.downloadBytes ?? ((url: string) => defaultDownload(url, maxBytes));
        const { bytes, contentType } = await dl(parsed.originalUrl);
        upsertImportItem(db, sourceTitle, "DOWNLOADED");
        const checked = validateAsset(bytes, contentType, maxBytes);
        sha256 = createHash("sha256").update(bytes).digest("hex");
        upsertImportItem(db, sourceTitle, "HASHED");
        assetUrl = await storeAsset(deps.assetDir, bytes, sha256, checked.ext);
        format = checked.format;
      } catch {
        // A bad asset must not kill the record: keep metadata, skip the mirror.
        format = formatFromMime(parsed.mime);
      }
    } else {
      format = formatFromMime(parsed.mime);
    }

    const { deduplicated } = insertSignatureFull(db, {
      artistId: resolution.artistId,
      type: classifyType(parsed),
      format,
      sha256,
      wikimediaSha1: parsed.sha1,
      width: parsed.width,
      height: parsed.height,
      fileSize: parsed.fileSize,
      assetUrl,
      source: {
        provider: "wikimedia_commons",
        sourceUrl: parsed.sourceUrl,
        originalUrl: parsed.originalUrl,
        sourceTitle: parsed.title,
        sourceId: parsed.pageId !== undefined ? String(parsed.pageId) : undefined,
        revisionId: meta.revid !== undefined ? String(meta.revid) : undefined,
      },
      license: { name: parsed.license.name, url: parsed.license.url, usageTerms: parsed.license.usageTerms, status: parsed.license.status },
      resolution: { method: resolution.method, confidence: resolution.confidence, rawName: resolution.rawName, matchedArtistId: resolution.artistId },
    });
    upsertImportItem(db, sourceTitle, deduplicated ? "DEDUPLICATED" : "IMPORTED");
    if (deduplicated) upsertImportItem(db, sourceTitle, "IMPORTED");
    return "imported";
  } catch (err) {
    failImportItem(db, sourceTitle, err instanceof Error ? err.message : String(err));
    return "failed";
  }
}

/** SPEC §25: upstream deletions mark records unavailable, never delete them. */
function handleUpstreamDelete(db: Db, sourceTitle: string): void {
  const rows = db.all<{ signatureId: string | null }>(
    sql`SELECT signature_id AS signatureId FROM sources WHERE source_title = ${sourceTitle};`,
  );
  for (const row of rows) {
    if (row.signatureId && getSignatureFull(db, row.signatureId)?.signature.status === "available") {
      setSignatureStatus(db, row.signatureId, "unavailable", "upstream_deleted", "importer");
    }
  }
}

/** Content-addressed mirror layout: assets/signatures/ab/cd/<sha256>.<ext>. */
export async function storeAsset(assetDir: string, bytes: Uint8Array, sha256: string, ext: string): Promise<string> {
  const rel = join("signatures", sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.${ext}`);
  const full = join(assetDir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes);
  return rel;
}

function formatFromMime(mime?: string): string {
  const entry = mime ? ALLOWED_TYPES[mime.split(";")[0].trim()] : undefined;
  if (!entry) return "other";
  return entry.format === "gif" ? "other" : entry.format;
}

interface Resolved {
  artistId?: string;
  method: string;
  confidence: number;
  rawName?: string;
  candidates: { artist: KnownArtist; confidence: number; method: string }[];
}

async function resolveToArtist(db: Db, deps: PipelineDeps, parsed: ParsedCommonsFile, known: KnownArtists, acceptThreshold: number, reviewThreshold: number): Promise<Resolved> {
  const lookupMb = deps.lookupMusicBrainz ?? ((name: string) => searchMusicBrainzArtist(name));
  const fetchWd = deps.fetchWikidata ?? fetchWikidataEntity;

  // Path 1: Wikidata entity -> artist (SPEC §13), MBID preferred.
  if (parsed.wikidataId) {
    const local = known.list.find((a) => a.wikidataId?.toLowerCase() === parsed.wikidataId!.toLowerCase());
    if (local?.musicbrainzId) {
      return { artistId: local.id, method: "wikidata_musicbrainz", confidence: 1, rawName: parsed.artist, candidates: [] };
    }
    if (local) {
      return { artistId: local.id, method: "wikidata", confidence: 0.9, rawName: parsed.artist, candidates: [] };
    }
    try {
      const entity = await fetchWd(parsed.wikidataId);
      if (entity) {
        const aliases = entity.aliases.slice(0, 10);
        const created = upsertArtist(
          db,
          { name: entity.label ?? parsed.artist ?? parsed.wikidataId, wikidataId: entity.qid, musicbrainzId: entity.musicbrainzId, aliases },
          normalizeName,
        );
        trackKnown(known, created, aliases);
        return {
          artistId: created.id,
          method: entity.musicbrainzId ? "wikidata_musicbrainz" : "wikidata",
          confidence: entity.musicbrainzId ? 1 : 0.9,
          rawName: parsed.artist,
          candidates: [],
        };
      }
    } catch {
      // Wikidata failures degrade to the remaining signals, never fatal.
    }
  }

  // Path 2: multi-signal scoring over known artists (SPEC §16).
  const scored = resolveArtist(parsed, known.list, { acceptThreshold, reviewThreshold });
  if (scored.artist?.id && scored.confidence >= acceptThreshold) {
    return { artistId: scored.artist.id, method: scored.method, confidence: scored.confidence, rawName: scored.candidates[0]?.rawName, candidates: [] };
  }

  // Path 3: MusicBrainz exact-name lookup for the description hint (SPEC §14).
  if (parsed.artist) {
    try {
      const mb = await lookupMb(parsed.artist);
      if (mb) {
        const aliases = mb.aliases?.slice(0, 10) ?? [];
        const created = upsertArtist(db, { name: mb.name, sortName: mb.sortName, musicbrainzId: mb.id, aliases }, normalizeName);
        trackKnown(known, created, aliases);
        return { artistId: created.id, method: "musicbrainz_name_match", confidence: 0.95, rawName: parsed.artist, candidates: [] };
      }
    } catch {
      // Identity-provider failures degrade gracefully.
    }
  }

  // Below the review threshold: park for humans (SPEC §59), keep candidates.
  if (scored.artist?.id && scored.confidence >= reviewThreshold) {
    return { artistId: scored.artist.id, method: scored.method, confidence: scored.confidence, rawName: scored.candidates[0]?.rawName, candidates: [] };
  }
  return { method: scored.method, confidence: scored.confidence, rawName: scored.candidates[0]?.rawName, candidates: scored.candidates };
}

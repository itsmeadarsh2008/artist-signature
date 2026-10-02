/**
 * Database schema (SPEC §22), SQLite via Drizzle.
 *
 * Covers: artists, artist_aliases, signatures, sources, licenses,
 * resolutions (§22.1-22.6), plus category_queue (§5.2), import_items for the
 * import state machine (§58), import_runs (§51), unresolved_signatures (§59),
 * moderation_actions (§42), and takedowns (§43).
 *
 * NOTE: `signatures.status` ("available" | "unavailable") extends the SPEC
 * §22.3 column list. It implements §25 (deleted upstream files are marked,
 * never deleted) and §43 (takedowns disable serving, provenance preserved).
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = () => new Date().toISOString();
const createdAt = () => text("created_at").notNull().$defaultFn(now);
const updatedAt = () => text("updated_at").notNull().$defaultFn(now);

export const artists = sqliteTable(
  "artists",
  {
    id: text("id").primaryKey(),
    musicbrainzId: text("musicbrainz_id").unique(),
    wikidataId: text("wikidata_id").unique(),
    name: text("name").notNull(),
    sortName: text("sort_name"),
    normalizedName: text("normalized_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("artists_normalized_name_idx").on(t.normalizedName)],
);

export const artistAliases = sqliteTable(
  "artist_aliases",
  {
    id: text("id").primaryKey(),
    artistId: text("artist_id")
      .notNull()
      .references(() => artists.id),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
  },
  (t) => [index("artist_aliases_normalized_idx").on(t.normalizedAlias)],
);

export const signatures = sqliteTable(
  "signatures",
  {
    id: text("id").primaryKey(),
    artistId: text("artist_id").references(() => artists.id),
    type: text("type").notNull().default("unknown"),
    format: text("format").notNull().default("other"),
    sha256: text("sha256").unique(),
    /** Secondary dedup signal: upstream file hash (SPEC §21). */
    wikimediaSha1: text("wikimedia_sha1"),
    width: integer("width"),
    height: integer("height"),
    fileSize: integer("file_size"),
    /** Mirror/CDN URL. Null when only the upstream original is referenced. */
    assetUrl: text("asset_url"),
    /** "available" | "unavailable". See module doc. Default available. */
    status: text("status").notNull().default("available"),
    verification: text("verification").notNull().default("unverified"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("signatures_artist_idx").on(t.artistId),
    index("signatures_sha256_idx").on(t.sha256),
  ],
);

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  signatureId: text("signature_id").references(() => signatures.id),
  provider: text("provider").notNull(),
  sourceUrl: text("source_url"),
  originalUrl: text("original_url"),
  sourceTitle: text("source_title"),
  sourceId: text("source_id"),
  revisionId: text("revision_id"),
  importedAt: text("imported_at").notNull().$defaultFn(now),
});

export const licenses = sqliteTable("licenses", {
  id: text("id").primaryKey(),
  signatureId: text("signature_id")
    .notNull()
    .references(() => signatures.id),
  name: text("name").notNull(),
  url: text("url"),
  usageTerms: text("usage_terms"),
  attributionRequired: integer("attribution_required", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("unknown"),
});

export const resolutions = sqliteTable("resolutions", {
  id: text("id").primaryKey(),
  signatureId: text("signature_id")
    .notNull()
    .references(() => signatures.id),
  method: text("method").notNull(),
  confidence: real("confidence").notNull(),
  rawName: text("raw_name"),
  matchedArtistId: text("matched_artist_id").references(() => artists.id),
  reviewed: integer("reviewed", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

/** SPEC §59. Unmatched signatures are kept, never discarded. */
export const unresolvedSignatures = sqliteTable("unresolved_signatures", {
  id: text("id").primaryKey(),
  rawTitle: text("raw_title").notNull(),
  description: text("description"),
  /** JSON array of category names. */
  categories: text("categories"),
  wikidataId: text("wikidata_id"),
  /** JSON array of {name, musicbrainzId, confidence, method}. */
  candidates: text("candidates"),
  confidence: real("confidence"),
  provider: text("provider").notNull().default("wikimedia_commons"),
  pageUrl: text("page_url"),
  originalUrl: text("original_url"),
  status: text("status").notNull().default("pending"),
  importedAt: text("imported_at").notNull().$defaultFn(now),
});

/**
 * SPEC §5.2 persistent category queue. A category is processed once unless
 * explicitly re-crawled; crashes resume from pending/processing rows.
 */
export const categoryQueue = sqliteTable("category_queue", {
  categoryTitle: text("category_title").primaryKey(),
  depth: integer("depth").notNull().default(0),
  status: text("status").notNull().default("pending"),
  discoveredAt: text("discovered_at").notNull().$defaultFn(now),
  processedAt: text("processed_at"),
  error: text("error"),
});

/**
 * SPEC §58 per-file import state machine: DISCOVERED -> METADATA_FETCHED ->
 * PARSED -> RESOLVED -> LICENSE_CHECKED -> DOWNLOADED -> HASHED ->
 * DEDUPLICATED -> IMPORTED, with FAILED for terminal/per-retry states.
 */
export const importItems = sqliteTable("import_items", {
  sourceTitle: text("source_title").primaryKey(),
  provider: text("provider").notNull().default("wikimedia_commons"),
  state: text("state").notNull().default("DISCOVERED"),
  pageId: integer("page_id"),
  revisionId: text("revision_id"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: updatedAt(),
});

/** SPEC §51 import logs. */
export const importRuns = sqliteTable("import_runs", {
  jobId: text("job_id").primaryKey(),
  source: text("source").notNull(),
  startedAt: text("started_at").notNull().$defaultFn(now),
  finishedAt: text("finished_at"),
  status: text("status").notNull().default("running"),
  itemsProcessed: integer("items_processed").notNull().default(0),
  itemsFailed: integer("items_failed").notNull().default(0),
  error: text("error"),
});

/** SPEC §42 audit trail: every moderation action is recorded. */
export const moderationActions = sqliteTable("moderation_actions", {
  id: text("id").primaryKey(),
  signatureId: text("signature_id").references(() => signatures.id),
  action: text("action").notNull(),
  actor: text("actor").notNull().default("admin"),
  reason: text("reason"),
  createdAt: createdAt(),
});

/** SPEC §43 takedown requests. */
export const takedowns = sqliteTable("takedowns", {
  id: text("id").primaryKey(),
  signatureId: text("signature_id")
    .notNull()
    .references(() => signatures.id),
  source: text("source"),
  reason: text("reason").notNull(),
  requester: text("requester").notNull(),
  contact: text("contact"),
  status: text("status").notNull().default("open"),
  createdAt: createdAt(),
});

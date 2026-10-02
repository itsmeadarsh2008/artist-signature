/**
 * Query helpers over the SPEC §22 schema. All functions take a `Db`
 * (or transaction) so callers compose them atomically.
 */

import { and, count, eq, gt, inArray, like, or, sql } from "drizzle-orm";
import {
  artistAliases,
  artists,
  categoryQueue,
  importItems,
  importRuns,
  licenses,
  moderationActions,
  resolutions,
  signatures,
  sources,
  takedowns,
  unresolvedSignatures,
} from "./schema";
import { newId } from "./ids";
import { scoreArtistMatch } from "@artist-signatures/resolver";
import type { Db } from "./client";

export type ArtistRow = typeof artists.$inferSelect;
export type SignatureRow = typeof signatures.$inferSelect;

export interface UpsertArtistInput {
  name: string;
  sortName?: string;
  musicbrainzId?: string;
  wikidataId?: string;
  aliases?: string[];
}

/** Idempotent artist upsert: MBID -> Wikidata -> normalized name. Fills gaps. */
export function upsertArtist(db: Db, input: UpsertArtistInput, normalize: (s: string) => string): ArtistRow {
  const normalized = normalize(input.name);
  let existing: ArtistRow | undefined;
  if (input.musicbrainzId) {
    existing = db.select().from(artists).where(eq(artists.musicbrainzId, input.musicbrainzId)).get();
  }
  if (!existing && input.wikidataId) {
    existing = db.select().from(artists).where(eq(artists.wikidataId, input.wikidataId)).get();
  }
  if (!existing) {
    existing = db.select().from(artists).where(eq(artists.normalizedName, normalized)).get();
  }
  if (existing) {
    const patch: Partial<ArtistRow> = { updatedAt: new Date().toISOString() };
    if (!existing.musicbrainzId && input.musicbrainzId) patch.musicbrainzId = input.musicbrainzId;
    if (!existing.wikidataId && input.wikidataId) patch.wikidataId = input.wikidataId;
    if (!existing.sortName && input.sortName) patch.sortName = input.sortName;
    db.update(artists).set(patch).where(eq(artists.id, existing.id)).run();
    addAliases(db, existing.id, input.aliases ?? [], normalize);
    return db.select().from(artists).where(eq(artists.id, existing.id)).get()!;
  }
  const row: ArtistRow = {
    id: newId("artist"),
    musicbrainzId: input.musicbrainzId ?? null,
    wikidataId: input.wikidataId ?? null,
    name: input.name,
    sortName: input.sortName ?? null,
    normalizedName: normalized,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.insert(artists).values(row).run();
  addAliases(db, row.id, input.aliases ?? [], normalize);
  return row;
}

function addAliases(db: Db, artistId: string, aliases: string[], normalize: (s: string) => string): void {
  const have = new Set(
    db.select().from(artistAliases).where(eq(artistAliases.artistId, artistId)).all().map((a) => a.normalizedAlias),
  );
  for (const alias of aliases) {
    const normalized = normalize(alias);
    if (normalized === "" || have.has(normalized)) continue;
    have.add(normalized);
    db.insert(artistAliases).values({ id: newId("alias"), artistId, alias, normalizedAlias: normalized }).run();
  }
}

/** Exact lookup by normalized name, including aliases. */
export function findArtistByNormalized(db: Db, normalized: string): ArtistRow | undefined {
  const direct = db.select().from(artists).where(eq(artists.normalizedName, normalized)).get();
  if (direct) return direct;
  const viaAlias = db
    .select({ artist: artists })
    .from(artistAliases)
    .innerJoin(artists, eq(artistAliases.artistId, artists.id))
    .where(eq(artistAliases.normalizedAlias, normalized))
    .get();
  return viaAlias?.artist;
}

export function findArtistByMbid(db: Db, mbid: string): ArtistRow | undefined {
  return db.select().from(artists).where(eq(artists.musicbrainzId, mbid)).get();
}

export interface SignatureFilters {
  format?: string;
  type?: string;
  license?: string;
  source?: string;
  verifiedOnly?: boolean;
  includeUnavailable?: boolean;
}

export interface FullSignature {
  signature: SignatureRow;
  artist: ArtistRow | null;
  sources: (typeof sources.$inferSelect)[];
  licenses: (typeof licenses.$inferSelect)[];
  resolutions: (typeof resolutions.$inferSelect)[];
}

export interface InsertSignatureInput {
  artistId?: string;
  type?: string;
  format?: string;
  sha256?: string;
  /** Upstream file hash, secondary dedup signal (SPEC §21). */
  wikimediaSha1?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  assetUrl?: string;
  source: {
    provider: string;
    sourceUrl?: string;
    originalUrl?: string;
    sourceTitle?: string;
    sourceId?: string;
    revisionId?: string;
  };
  license: { name: string; url?: string; usageTerms?: string; attributionRequired?: boolean; status: string };
  resolution?: { method: string; confidence: number; rawName?: string; matchedArtistId?: string };
}

/**
 * Inserts a signature with its source/license/resolution atomically.
 * SPEC §21 dedup: identical bytes (sha256) resolve to one asset; a new
 * source row is still attached so provenance is never lost.
 */
export function insertSignatureFull(db: Db, input: InsertSignatureInput): { signatureId: string; deduplicated: boolean } {
  return db.transaction((tx) => {
    if (input.sha256) {
      const hit = tx.select().from(signatures).where(eq(signatures.sha256, input.sha256)).get();
      if (hit) {
        attachSource(tx, hit.id, input.source);
        return { signatureId: hit.id, deduplicated: true };
      }
    }
    const now = new Date().toISOString();
    const sig: SignatureRow = {
      id: newId("sig"),
      artistId: input.artistId ?? null,
      type: input.type ?? "unknown",
      format: input.format ?? "other",
      sha256: input.sha256 ?? null,
      wikimediaSha1: input.wikimediaSha1 ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      fileSize: input.fileSize ?? null,
      assetUrl: input.assetUrl ?? null,
      status: "available",
      verification: "unverified",
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(signatures).values(sig).run();
    attachSource(tx, sig.id, input.source);
    tx.insert(licenses)
      .values({
        id: newId("lic"),
        signatureId: sig.id,
        name: input.license.name,
        url: input.license.url ?? null,
        usageTerms: input.license.usageTerms ?? null,
        attributionRequired: input.license.attributionRequired ?? false,
        status: input.license.status,
      })
      .run();
    if (input.resolution) {
      tx.insert(resolutions)
        .values({
          id: newId("res"),
          signatureId: sig.id,
          method: input.resolution.method,
          confidence: input.resolution.confidence,
          rawName: input.resolution.rawName ?? null,
          matchedArtistId: input.resolution.matchedArtistId ?? input.artistId ?? null,
          reviewed: false,
          createdAt: now,
        })
        .run();
    }
    return { signatureId: sig.id, deduplicated: false };
  });
}

function attachSource(tx: Db, signatureId: string, source: InsertSignatureInput["source"]): void {
  const dup = source.sourceTitle
    ? tx
        .select()
        .from(sources)
        .where(and(eq(sources.signatureId, signatureId), eq(sources.sourceTitle, source.sourceTitle)))
        .get()
    : undefined;
  if (dup) return;
  tx.insert(sources)
    .values({
      id: newId("src"),
      signatureId,
      provider: source.provider,
      sourceUrl: source.sourceUrl ?? null,
      originalUrl: source.originalUrl ?? null,
      sourceTitle: source.sourceTitle ?? null,
      sourceId: source.sourceId ?? null,
      revisionId: source.revisionId ?? null,
      importedAt: new Date().toISOString(),
    })
    .run();
}

/** Metadata-level dedup/skip: existing source rows for one upstream title. */
export function findSourcesByTitle(db: Db, provider: string, sourceTitle: string) {
  return db
    .select()
    .from(sources)
    .where(and(eq(sources.provider, provider), eq(sources.sourceTitle, sourceTitle)))
    .all();
}

export function getSignatureFull(db: Db, id: string): FullSignature | undefined {
  const signature = db.select().from(signatures).where(eq(signatures.id, id)).get();
  if (!signature) return undefined;
  const artist = signature.artistId
    ? db.select().from(artists).where(eq(artists.id, signature.artistId)).get() ?? null
    : null;
  return {
    signature,
    artist,
    sources: db.select().from(sources).where(eq(sources.signatureId, id)).all(),
    licenses: db.select().from(licenses).where(eq(licenses.signatureId, id)).all(),
    resolutions: db.select().from(resolutions).where(eq(resolutions.signatureId, id)).all(),
  };
}

function signatureCondition(artistId: string, filters: SignatureFilters) {
  const conds = [eq(signatures.artistId, artistId)];
  if (!filters.includeUnavailable) conds.push(eq(signatures.status, "available"));
  if (filters.format) conds.push(eq(signatures.format, filters.format));
  if (filters.type) conds.push(eq(signatures.type, filters.type));
  if (filters.verifiedOnly) conds.push(eq(signatures.verification, "verified"));
  return conds;
}

function encodeCursor(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function decodeCursor<T>(cursor: string): T {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
}

export interface SignaturePage {
  items: FullSignature[];
  nextCursor?: string;
}

/** Keyset pagination over (created_at, id): stable under concurrent imports. */
export function listSignaturesForArtist(
  db: Db,
  artistId: string,
  filters: SignatureFilters,
  limit = 20,
  cursor?: string,
): SignaturePage {
  const conds = signatureCondition(artistId, filters);
  if (cursor) {
    const { c, i } = decodeCursor<{ c: string; i: string }>(cursor);
    conds.push(or(gt(signatures.createdAt, c), and(eq(signatures.createdAt, c), gt(signatures.id, i)))!);
  }
  // License/source live on joined rows: fetch the page, filter, then hydrate.
  let rows = db
    .select()
    .from(signatures)
    .where(and(...conds))
    .orderBy(signatures.createdAt, signatures.id)
    .limit(limit + 1)
    .all();
  if (filters.license || filters.source) {
    const ids = new Set(rows.map((r) => r.id));
    if (filters.license) {
      const keep = new Set(
        db.select().from(licenses).where(inArray(licenses.signatureId, [...ids])).all()
          .filter((l) => l.name === filters.license).map((l) => l.signatureId),
      );
      rows = rows.filter((r) => keep.has(r.id));
    }
    if (filters.source) {
      const keep = new Set(
        db.select().from(sources).where(inArray(sources.signatureId, [...ids])).all()
          .filter((s) => s.provider === filters.source).map((s) => s.signatureId!),
      );
      rows = rows.filter((r) => keep.has(r.id));
    }
    rows = rows.slice(0, limit + 1);
  }
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.id);
  const licBySig = new Map<string, (typeof licenses.$inferSelect)[]>();
  const srcBySig = new Map<string, (typeof sources.$inferSelect)[]>();
  if (ids.length > 0) {
    for (const l of db.select().from(licenses).where(inArray(licenses.signatureId, ids)).all()) {
      const arr = licBySig.get(l.signatureId) ?? [];
      arr.push(l);
      licBySig.set(l.signatureId, arr);
    }
    for (const s of db.select().from(sources).where(inArray(sources.signatureId, ids)).all()) {
      if (!s.signatureId) continue;
      const arr = srcBySig.get(s.signatureId) ?? [];
      arr.push(s);
      srcBySig.set(s.signatureId, arr);
    }
  }
  const artist = db.select().from(artists).where(eq(artists.id, artistId)).get() ?? null;
  const items: FullSignature[] = page.map((signature) => ({
    signature,
    artist,
    sources: srcBySig.get(signature.id) ?? [],
    licenses: licBySig.get(signature.id) ?? [],
    resolutions: [],
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor({ c: last.createdAt, i: last.id }) : undefined };
}

export interface SearchResult {
  artist: ArtistRow;
  signatureCount: number;
}

/**
 * Name search over artists + aliases, ranked by match quality.
 *
 * SQL does recall (exact, prefix, contains, per-token LIKEs over names and
 * aliases, capped); `scoreArtistMatch` does precision in JS (exact 100 →
 * prefix 80 → token-set 70 → fuzzy ≥30). Token LIKEs give recall for
 * reordered queries ("Lipa Dua") and single-token typos ("Dua Lpia"); the JS
 * scorer then decides the order. Multi-token typos in every token can still
 * miss —finding those would need a full-table scan per query.
 * Opaque offset cursor (ranked results have no natural keyset).
 */
const SEARCH_POOL_CAP = 500;

export function searchArtists(db: Db, query: string, normalize: (s: string) => string, limit = 20, cursor?: string): { results: SearchResult[]; nextCursor?: string } {
  const q = normalize(query);
  if (q === "") return { results: [] };
  const safe = q.replace(/[%_]/g, "");
  const likeQ = `%${safe}%`;
  const pool = new Map<string, ArtistRow>();
  const add = (rows: ArtistRow[]) => {
    for (const a of rows) {
      if (pool.size >= SEARCH_POOL_CAP) return;
      pool.set(a.id, a);
    }
  };
  add(db.select().from(artists).where(eq(artists.normalizedName, q)).all());
  add(
    db
      .select({ artist: artists })
      .from(artistAliases)
      .innerJoin(artists, eq(artistAliases.artistId, artists.id))
      .where(eq(artistAliases.normalizedAlias, q))
      .all()
      .map((r) => r.artist),
  );
  add(db.select().from(artists).where(like(artists.normalizedName, `${safe}%`)).all());
  add(db.select().from(artists).where(like(artists.normalizedName, likeQ)).all());
  for (const token of new Set(q.split(/\s+/).filter((t) => t.length >= 2))) {
    if (pool.size >= SEARCH_POOL_CAP) break;
    add(db.select().from(artists).where(like(artists.normalizedName, `%${token.replace(/[%_]/g, "")}%`)).all());
    if (pool.size >= SEARCH_POOL_CAP) break;
    add(
      db
        .select({ artist: artists })
        .from(artistAliases)
        .innerJoin(artists, eq(artistAliases.artistId, artists.id))
        .where(like(artistAliases.normalizedAlias, `%${token.replace(/[%_]/g, "")}%`))
        .all()
        .map((r) => r.artist),
    );
  }

  const ids = [...pool.keys()];
  const aliasLists = new Map<string, string[]>();
  if (ids.length > 0) {
    for (const row of db.select().from(artistAliases).where(inArray(artistAliases.artistId, ids)).all()) {
      const arr = aliasLists.get(row.artistId) ?? [];
      arr.push(row.normalizedAlias);
      aliasLists.set(row.artistId, arr);
    }
  }
  const scored = [...pool.values()]
    .map((artist) => ({ artist, match: scoreArtistMatch(q, artist.normalizedName, aliasLists.get(artist.id) ?? []) }))
    .filter((e) => e.match.score > 0)
    .sort((a, b) => b.match.score - a.match.score || a.artist.name.localeCompare(b.artist.name));

  const offset = cursor ? (decodeCursor<{ o: number }>(cursor).o ?? 0) : 0;
  const slice = scored.slice(offset, offset + limit);
  const results: SearchResult[] = slice.map(({ artist }) => ({
    artist,
    signatureCount:
      db.select({ n: count() }).from(signatures).where(and(eq(signatures.artistId, artist.id), eq(signatures.status, "available"))).get()?.n ?? 0,
  }));
  const next = offset + limit < scored.length ? encodeCursor({ o: offset + limit }) : undefined;
  return { results, nextCursor: next };
}

// ---------------------------------------------------------------------------
// Review queue, moderation, takedowns (SPEC §42, §43, §60)
// ---------------------------------------------------------------------------

export interface PendingResolution {
  resolution: typeof resolutions.$inferSelect;
  signature: SignatureRow;
  artist: ArtistRow | null;
}

export function listPendingResolutions(db: Db, limit = 20): PendingResolution[] {
  return db
    .select({ resolution: resolutions, signature: signatures })
    .from(resolutions)
    .innerJoin(signatures, eq(resolutions.signatureId, signatures.id))
    .where(eq(resolutions.reviewed, false))
    .orderBy(resolutions.confidence)
    .limit(limit)
    .all()
    .map(({ resolution, signature }) => ({
      resolution,
      signature,
      artist: signature.artistId ? db.select().from(artists).where(eq(artists.id, signature.artistId)).get() ?? null : null,
    }));
}

export function approveResolution(db: Db, resolutionId: string, actor = "admin"): void {
  db.transaction((tx) => {
    const res = tx.select().from(resolutions).where(eq(resolutions.id, resolutionId)).get();
    if (!res) throw new Error(`resolution not found: ${resolutionId}`);
    tx.update(resolutions).set({ reviewed: true }).where(eq(resolutions.id, resolutionId)).run();
    tx.update(signatures).set({ verification: "verified", updatedAt: new Date().toISOString() }).where(eq(signatures.id, res.signatureId)).run();
    tx.insert(moderationActions).values({ id: newId("mod"), signatureId: res.signatureId, action: "approve", actor }).run();
  });
}

export function setSignatureStatus(db: Db, signatureId: string, status: "available" | "unavailable", action: string, actor = "admin", reason?: string): void {
  db.transaction((tx) => {
    tx.update(signatures).set({ status, updatedAt: new Date().toISOString() }).where(eq(signatures.id, signatureId)).run();
    tx.insert(moderationActions).values({ id: newId("mod"), signatureId, action, actor, reason: reason ?? null }).run();
  });
}

export function setVerification(db: Db, signatureId: string, verification: "unverified" | "verified" | "artist_verified", actor = "admin"): void {
  db.transaction((tx) => {
    tx.update(signatures).set({ verification, updatedAt: new Date().toISOString() }).where(eq(signatures.id, signatureId)).run();
    tx.insert(moderationActions).values({ id: newId("mod"), signatureId, action: `verify:${verification}`, actor }).run();
  });
}

export interface TakedownInput {
  signatureId: string;
  source?: string;
  reason: string;
  requester: string;
  contact?: string;
}

/** Records the request and immediately disables public serving (SPEC §43). */
export function applyTakedown(db: Db, input: TakedownInput): string {
  return db.transaction((tx) => {
    const sig = tx.select().from(signatures).where(eq(signatures.id, input.signatureId)).get();
    if (!sig) throw new Error(`signature not found: ${input.signatureId}`);
    const id = newId("td");
    tx.insert(takedowns).values({ id, signatureId: input.signatureId, source: input.source ?? null, reason: input.reason, requester: input.requester, contact: input.contact ?? null, status: "open" }).run();
    tx.update(signatures).set({ status: "unavailable", updatedAt: new Date().toISOString() }).where(eq(signatures.id, input.signatureId)).run();
    tx.insert(moderationActions).values({ id: newId("mod"), signatureId: input.signatureId, action: "takedown", actor: input.requester, reason: input.reason }).run();
    return id;
  });
}

// ---------------------------------------------------------------------------
// Unresolved signatures (SPEC §59)
// ---------------------------------------------------------------------------

export interface UnresolvedCandidate {
  name: string;
  musicbrainzId?: string;
  confidence: number;
  method: string;
}

export function insertUnresolved(
  db: Db,
  input: { rawTitle: string; description?: string; categories?: string[]; wikidataId?: string; candidates?: UnresolvedCandidate[]; confidence?: number; provider?: string; pageUrl?: string; originalUrl?: string },
): string {
  const id = newId("unres");
  db.insert(unresolvedSignatures)
    .values({
      id,
      rawTitle: input.rawTitle,
      description: input.description ?? null,
      categories: input.categories ? JSON.stringify(input.categories) : null,
      wikidataId: input.wikidataId ?? null,
      candidates: input.candidates ? JSON.stringify(input.candidates) : null,
      confidence: input.confidence ?? null,
      provider: input.provider ?? "wikimedia_commons",
      pageUrl: input.pageUrl ?? null,
      originalUrl: input.originalUrl ?? null,
      status: "pending",
      importedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

export function listPendingUnresolved(db: Db, limit = 20) {
  return db.select().from(unresolvedSignatures).where(eq(unresolvedSignatures.status, "pending")).limit(limit).all();
}

// ---------------------------------------------------------------------------
// Category queue (SPEC §5.2) and import state (SPEC §51, §58)
// ---------------------------------------------------------------------------

export function enqueueCategory(db: Db, title: string, depth = 0): void {
  db.insert(categoryQueue).values({ categoryTitle: title, depth, status: "pending", discoveredAt: new Date().toISOString() }).onConflictDoNothing().run();
}

export function claimNextCategory(db: Db) {
  const row = db.select().from(categoryQueue).where(eq(categoryQueue.status, "pending")).orderBy(categoryQueue.depth).get();
  if (!row) return undefined;
  db.update(categoryQueue).set({ status: "processing" }).where(eq(categoryQueue.categoryTitle, row.categoryTitle)).run();
  return row;
}

export function finishCategory(db: Db, title: string, error?: string): void {
  db.update(categoryQueue)
    .set({ status: error ? "failed" : "completed", processedAt: new Date().toISOString(), error: error ?? null })
    .where(eq(categoryQueue.categoryTitle, title))
    .run();
}

export type ImportState = "DISCOVERED" | "METADATA_FETCHED" | "PARSED" | "RESOLVED" | "LICENSE_CHECKED" | "DOWNLOADED" | "HASHED" | "DEDUPLICATED" | "IMPORTED" | "FAILED";

export function upsertImportItem(db: Db, sourceTitle: string, state: ImportState, provider = "wikimedia_commons"): void {
  db.insert(importItems)
    .values({ sourceTitle, provider, state, attempts: 0, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: importItems.sourceTitle,
      set: { state, updatedAt: new Date().toISOString(), lastError: null },
    })
    .run();
}

export function failImportItem(db: Db, sourceTitle: string, error: string): void {
  const row = db.select().from(importItems).where(eq(importItems.sourceTitle, sourceTitle)).get();
  const attempts = (row?.attempts ?? 0) + 1;
  db.insert(importItems)
    .values({ sourceTitle, state: "FAILED", attempts, lastError: error, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: importItems.sourceTitle, set: { state: "FAILED", attempts, lastError: error, updatedAt: new Date().toISOString() } })
    .run();
}

export function getImportItem(db: Db, sourceTitle: string) {
  return db.select().from(importItems).where(eq(importItems.sourceTitle, sourceTitle)).get();
}

export function startRun(db: Db, source: string): string {
  const jobId = newId("job");
  db.insert(importRuns).values({ jobId, source, startedAt: new Date().toISOString(), status: "running", itemsProcessed: 0, itemsFailed: 0 }).run();
  return jobId;
}

export function finishRun(db: Db, jobId: string, status: "completed" | "failed", itemsProcessed: number, itemsFailed: number, error?: string): void {
  db.update(importRuns)
    .set({ status, finishedAt: new Date().toISOString(), itemsProcessed, itemsFailed, error: error ?? null })
    .where(eq(importRuns.jobId, jobId))
    .run();
}

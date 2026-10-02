import { describe, expect, test } from "bun:test";
// Relative import keeps this package dependency-free; apps wire workspaces.
import { normalizeName } from "../../resolver/src/normalize";
import { createDb, migrateToLatest, type Db } from "./client";
import {
  applyTakedown,
  approveResolution,
  claimNextCategory,
  enqueueCategory,
  failImportItem,
  findArtistByMbid,
  findArtistByNormalized,
  finishCategory,
  finishRun,
  getImportItem,
  getSignatureFull,
  insertSignatureFull,
  insertUnresolved,
  listPendingResolutions,
  listPendingUnresolved,
  listSignaturesForArtist,
  searchArtists,
  startRun,
  upsertArtist,
  upsertImportItem,
} from "./queries";

const MIGRATIONS = new URL("../../../migrations", import.meta.url).pathname;

function freshDb(): Db {
  const { db } = createDb(":memory:");
  const applied = migrateToLatest(db, MIGRATIONS);
  expect(applied.length).toBeGreaterThan(0);
  // Second run must be a no-op (crash-safe, idempotent).
  expect(migrateToLatest(db, MIGRATIONS)).toEqual([]);
  return db;
}

function seedDua(db: Db) {
  return upsertArtist(db, { name: "Dua Lipa", musicbrainzId: "mbid-dua", wikidataId: "Q12345", aliases: ["Dua Lipa Singer"] }, normalizeName);
}

function seedSig(db: Db, artistId: string, sha256 = "aa".repeat(32)) {
  return insertSignatureFull(db, {
    artistId,
    type: "handwritten",
    format: "svg",
    sha256,
    width: 200,
    height: 100,
    fileSize: 1234,
    assetUrl: "https://cdn.example.com/x.svg",
    source: { provider: "wikimedia_commons", sourceTitle: "File:Dua Lipa.svg", sourceUrl: "https://commons.wikimedia.org/wiki/File:X", originalUrl: "https://upload.wikimedia.org/x.svg" },
    license: { name: "PD-signature", url: "https://commons.wikimedia.org/wiki/Template:PD-signature", status: "known" },
    resolution: { method: "wikidata_musicbrainz", confidence: 1, rawName: "Dua Lipa", matchedArtistId: artistId },
  });
}

describe("artists", () => {
  test("upsert is idempotent and fills gaps", () => {
    const db = freshDb();
    const a = seedDua(db);
    const b = upsertArtist(db, { name: "DUA LIPA", musicbrainzId: "mbid-dua" }, normalizeName);
    expect(b.id).toBe(a.id);
    expect(searchArtists(db, "dua", normalizeName).results).toHaveLength(1);
  });

  test("lookup by normalized name, alias, and mbid", () => {
    const db = freshDb();
    const a = seedDua(db);
    expect(findArtistByNormalized(db, "dua lipa")?.id).toBe(a.id);
    expect(findArtistByNormalized(db, "dua lipa singer")?.id).toBe(a.id);
    expect(findArtistByMbid(db, "mbid-dua")?.id).toBe(a.id);
    expect(findArtistByNormalized(db, "madonna")).toBeUndefined();
  });
});

describe("signatures", () => {
  test("sha256 dedup keeps one asset but attaches the new source", () => {
    const db = freshDb();
    const a = seedDua(db);
    const first = seedSig(db, a.id);
    expect(first.deduplicated).toBe(false);
    const second = insertSignatureFull(db, {
      artistId: a.id,
      format: "svg",
      sha256: "aa".repeat(32),
      source: { provider: "wikimedia_commons", sourceTitle: "File:Dua Lipa signature.svg" },
      license: { name: "PD-signature", status: "known" },
    });
    expect(second.deduplicated).toBe(true);
    expect(second.signatureId).toBe(first.signatureId);
    const full = getSignatureFull(db, first.signatureId)!;
    expect(full.sources).toHaveLength(2);
    expect(full.licenses[0].name).toBe("PD-signature");
  });

  test("listing paginates with keyset cursors and honors filters", () => {
    const db = freshDb();
    const a = seedDua(db);
    seedSig(db, a.id, "01".repeat(32));
    seedSig(db, a.id, "02".repeat(32));
    seedSig(db, a.id, "03".repeat(32));
    const p1 = listSignaturesForArtist(db, a.id, {}, 2);
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeDefined();
    const p2 = listSignaturesForArtist(db, a.id, {}, 2, p1.nextCursor);
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
    // Pages must not overlap.
    expect(new Set([...p1.items, ...p2.items].map((s) => s.signature.id)).size).toBe(3);
    expect(listSignaturesForArtist(db, a.id, { format: "png" }, 10).items).toHaveLength(0);
    expect(listSignaturesForArtist(db, a.id, { license: "PD-signature" }, 10).items).toHaveLength(3);
    expect(listSignaturesForArtist(db, a.id, { source: "other" }, 10).items).toHaveLength(0);
  });
});

describe("search", () => {
  test("exact beats prefix; opaque cursor paginates", () => {
    const db = freshDb();
    seedDua(db);
    upsertArtist(db, { name: "Dua Lipa Tribute Band" }, normalizeName);
    const { results, nextCursor } = searchArtists(db, "dua lipa", normalizeName, 1);
    expect(results).toHaveLength(1);
    expect(results[0].artist.name).toBe("Dua Lipa");
    expect(results[0].signatureCount).toBe(0);
    expect(nextCursor).toBeDefined();
    const rest = searchArtists(db, "dua lipa", normalizeName, 10, nextCursor);
    expect(rest.results.map((r) => r.artist.name)).toEqual(["Dua Lipa Tribute Band"]);
    expect(rest.nextCursor).toBeUndefined();
    expect(searchArtists(db, "   ", normalizeName).results).toEqual([]);
  });

  test("tolerates typos, reordered tokens, and alias hits", () => {
    const db = freshDb();
    seedDua(db);
    upsertArtist(db, { name: "Madonna" }, normalizeName);
    // Single-token typo: token LIKE gives recall, fuzzy scoring ranks it top.
    expect(searchArtists(db, "dua lpia", normalizeName).results[0]?.artist.name).toBe("Dua Lipa");
    // Reordered tokens.
    expect(searchArtists(db, "lipa dua", normalizeName).results[0]?.artist.name).toBe("Dua Lipa");
    // Alias exact outranks unrelated prefix matches.
    upsertArtist(db, { name: "Dua Lipa Tribute Band" }, normalizeName);
    expect(searchArtists(db, "dua lipa singer", normalizeName).results[0]?.artist.name).toBe("Dua Lipa");
    // Prefix still works; unrelated names still miss.
    expect(searchArtists(db, "du", normalizeName).results[0]?.artist.name).toBe("Dua Lipa");
    expect(searchArtists(db, "xyzzy plugh", normalizeName).results).toEqual([]);
  });
});

describe("moderation and takedowns", () => {
  test("approve marks reviewed + verified with an audit row", () => {
    const db = freshDb();
    const a = seedDua(db);
    const { signatureId } = seedSig(db, a.id);
    const [pending] = listPendingResolutions(db);
    expect(pending.signature.id).toBe(signatureId);
    approveResolution(db, pending.resolution.id, "mod-1");
    expect(listPendingResolutions(db)).toHaveLength(0);
    expect(getSignatureFull(db, signatureId)!.signature.verification).toBe("verified");
  });

  test("takedown disables serving but preserves the record", () => {
    const db = freshDb();
    const a = seedDua(db);
    const { signatureId } = seedSig(db, a.id);
    const tdId = applyTakedown(db, { signatureId, reason: "artist request", requester: "label@example.com" });
    expect(typeof tdId).toBe("string");
    expect(listSignaturesForArtist(db, a.id, {}, 10).items).toHaveLength(0);
    expect(listSignaturesForArtist(db, a.id, { includeUnavailable: true }, 10).items).toHaveLength(1);
    expect(getSignatureFull(db, signatureId)!.signature.status).toBe("unavailable");
  });
});

describe("import state", () => {
  test("category queue is claim-once and resumable", () => {
    const db = freshDb();
    enqueueCategory(db, "Category:Signatures", 0);
    enqueueCategory(db, "Category:Signatures", 0); // duplicate ignored
    enqueueCategory(db, "Category:Signatures of Dua Lipa", 1);
    const first = claimNextCategory(db)!;
    expect(first.categoryTitle).toBe("Category:Signatures");
    expect(claimNextCategory(db)!.categoryTitle).toBe("Category:Signatures of Dua Lipa");
    expect(claimNextCategory(db)).toBeUndefined();
    finishCategory(db, "Category:Signatures");
    // A crash leaves "processing" rows behind; they can be reclaimed later.
  });

  test("import items track the state machine and attempts", () => {
    const db = freshDb();
    upsertImportItem(db, "File:X.svg", "DISCOVERED");
    upsertImportItem(db, "File:X.svg", "PARSED");
    expect(getImportItem(db, "File:X.svg")?.state).toBe("PARSED");
    failImportItem(db, "File:X.svg", "boom");
    const failed = getImportItem(db, "File:X.svg")!;
    expect(failed.state).toBe("FAILED");
    expect(failed.attempts).toBe(1);
  });

  test("runs log start and finish", () => {
    const db = freshDb();
    const job = startRun(db, "crawl-category");
    finishRun(db, job, "completed", 10, 1);
  });

  test("unresolved signatures are kept for later", () => {
    const db = freshDb();
    insertUnresolved(db, { rawTitle: "File:Mystery.svg", candidates: [{ name: "Mystery", confidence: 0.5, method: "fuzzy_filename_match" }] });
    expect(listPendingUnresolved(db)).toHaveLength(1);
  });
});

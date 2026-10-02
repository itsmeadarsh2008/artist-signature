import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDb, getSignatureFull, listPendingUnresolved, migrateToLatest, upsertImportItem, type Db } from "@artist-signatures/database";
import type { CommonsFileInput } from "@artist-signatures/parser";
import { buildKnownArtists, classifyType, processDiscoveredFile, validateAsset, type PipelineDeps } from "./pipeline";
import type { CommonsClient } from "./wikimedia";

const MIGRATIONS = new URL("../../../migrations", import.meta.url).pathname;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

function meta(overrides: Partial<CommonsFileInput> = {}): CommonsFileInput {
  return {
    title: "File:Test Sig.svg",
    pageid: 10,
    revid: 111,
    url: "https://upload.wikimedia.org/t.svg",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Test",
    mime: "image/svg+xml",
    size: 12,
    width: 100,
    height: 50,
    sha1: "upstream-sha1",
    extmetadata: {
      ImageDescription: { value: "Signature of Test Artist" },
      LicenseShortName: { value: "PD" },
    },
    wikitext: "{{PD-signature}}\n[[Category:Signatures of Test Artist]]",
    ...overrides,
  };
}

function deps(assetDir: string, metas: CommonsFileInput[], opts: Partial<PipelineDeps> = {}): PipelineDeps {
  const client = { fetchFileMetadata: async () => metas } as unknown as CommonsClient;
  return {
    client,
    assetDir,
    downloadBytes: async () => ({ bytes: PNG, contentType: "image/png" }),
    lookupMusicBrainz: async () => ({ id: "mb-test", name: "Test Artist", aliases: ["TA"] }),
    fetchWikidata: async () => undefined,
    ...opts,
  };
}

function freshDb(): Db {
  const { db } = createDb(":memory:");
  migrateToLatest(db, MIGRATIONS);
  return db;
}

describe("validateAsset", () => {
  test("accepts PNG by magic, rejects garbage and oversize", () => {
    expect(validateAsset(PNG, "image/png", 100)).toEqual({ ext: "png", format: "png" });
    expect(() => validateAsset(new Uint8Array([1, 2, 3]), "image/png", 100)).toThrow();
    expect(() => validateAsset(PNG, "image/png", 4)).toThrow(/too large/);
    expect(() => validateAsset(new Uint8Array(0), "image/png", 100)).toThrow(/empty/);
  });
  test("accepts SVG text, rejects content-type mismatch", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(validateAsset(svg, "image/svg+xml", 1000)).toEqual({ ext: "svg", format: "svg" });
    expect(() => validateAsset(svg, "image/png", 1000)).toThrow(/does not match/);
  });
});

describe("classifyType", () => {
  test("metadata keywords map to types, default unknown", () => {
    const base = { title: "", categories: [] as string[], license: { name: "Unknown", source: "wikimedia", status: "unknown" } } as const;
    expect(classifyType({ ...base, title: "File:X monogram.svg" })).toBe("monogram");
    expect(classifyType({ ...base, title: "File:Autograph of X.jpg" })).toBe("autograph");
    expect(classifyType({ ...base, title: "File:Random.png" })).toBe("unknown");
  });
});

describe("processDiscoveredFile", () => {
  test("full path: MB resolution, mirror, hashed, imported", async () => {
    const db = freshDb();
    const assetDir = await mkdtemp(join(tmpdir(), "assets-"));
    const known = buildKnownArtists(db);
    const outcome = await processDiscoveredFile(db, deps(assetDir, [meta()]), "File:Test Sig.svg", known);
    expect(outcome).toBe("imported");

    const { sql } = await import("drizzle-orm");
    const sigs = db.all<{ id: string }>(sql`SELECT id FROM signatures;`);
    expect(sigs).toHaveLength(1);
    const full = getSignatureFull(db, sigs[0].id)!;
    expect(full.artist?.musicbrainzId).toBe("mb-test");
    expect(full.licenses[0]).toMatchObject({ name: "PD-signature", status: "known" });
    expect(full.signature.wikimediaSha1).toBe("upstream-sha1");
    const expectedSha = createHash("sha256").update(PNG).digest("hex");
    expect(full.signature.sha256).toBe(expectedSha);
    expect(full.signature.assetUrl).toBe(`signatures/${expectedSha.slice(0, 2)}/${expectedSha.slice(2, 4)}/${expectedSha}.png`);
    expect(existsSync(join(assetDir, full.signature.assetUrl!))).toBe(true);
    expect(readFileSync(join(assetDir, full.signature.assetUrl!))).toEqual(Buffer.from(PNG));
  });

  test("wikidata path creates the artist with MBID at confidence 1", async () => {
    const db = freshDb();
    const assetDir = await mkdtemp(join(tmpdir(), "assets-"));
    const m = meta({ title: "File:WD Sig.svg", wikitext: "{{PD-signature}}\nSee https://www.wikidata.org/wiki/Q777" });
    const d = deps(assetDir, [m], {
      lookupMusicBrainz: async () => undefined,
      fetchWikidata: async () => ({ qid: "Q777", label: "WD Star", aliases: ["WDS"], musicbrainzId: "mb-wd" }),
    });
    expect(await processDiscoveredFile(db, d, "File:WD Sig.svg", buildKnownArtists(db))).toBe("imported");
    const { sql } = await import("drizzle-orm");
    const artists = db.all<{ musicbrainzId: string }>(sql`SELECT musicbrainz_id AS musicbrainzId FROM artists;`);
    expect(artists).toEqual([{ musicbrainzId: "mb-wd" }]);
    const res = db.all<{ method: string; confidence: number }>(sql`SELECT method, confidence FROM resolutions;`);
    expect(res).toEqual([{ method: "wikidata_musicbrainz", confidence: 1 }]);
  });

  test("restricted license: metadata kept, nothing mirrored", async () => {
    const db = freshDb();
    const assetDir = await mkdtemp(join(tmpdir(), "assets-"));
    let downloaded = false;
    const m = meta({ title: "File:Restricted.svg", wikitext: "{{Non-free biog-pic}}" });
    const d = deps(assetDir, [m], { downloadBytes: async () => { downloaded = true; return { bytes: PNG }; } });
    expect(await processDiscoveredFile(db, d, "File:Restricted.svg", buildKnownArtists(db))).toBe("imported");
    expect(downloaded).toBe(false);
    const { sql } = await import("drizzle-orm");
    const sigs = db.all<{ assetUrl: string | null }>(sql`SELECT asset_url AS assetUrl FROM signatures;`);
    expect(sigs[0].assetUrl).toBeNull();
  });

  test("no identity anywhere: parked unresolved, candidates kept", async () => {
    const db = freshDb();
    const assetDir = await mkdtemp(join(tmpdir(), "assets-"));
    const m = meta({ title: "File:Mystery.svg", extmetadata: { ImageDescription: { value: "Signature of Mystery Person" } }, wikitext: "{{PD-signature}}" });
    const d = deps(assetDir, [m], { lookupMusicBrainz: async () => undefined });
    expect(await processDiscoveredFile(db, d, "File:Mystery.svg", buildKnownArtists(db))).toBe("unresolved");
    const pending = listPendingUnresolved(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].rawTitle).toBe("File:Mystery.svg");
  });

  test("same upstream revision is skipped (incremental update)", async () => {
    const db = freshDb();
    const assetDir = await mkdtemp(join(tmpdir(), "assets-"));
    const d = deps(assetDir, [meta()]);
    const known = buildKnownArtists(db);
    expect(await processDiscoveredFile(db, d, "File:Test Sig.svg", known)).toBe("imported");
    // Simulate a re-crawl: item back to DISCOVERED, same upstream revision.
    upsertImportItem(db, "File:Test Sig.svg", "DISCOVERED");
    expect(await processDiscoveredFile(db, d, "File:Test Sig.svg", known)).toBe("skipped");
  });

  test("missing upstream marks linked signatures unavailable", async () => {
    const db = freshDb();
    const assetDir = await mkdtemp(join(tmpdir(), "assets-"));
    const d = deps(assetDir, [meta()]);
    const known = buildKnownArtists(db);
    await processDiscoveredFile(db, d, "File:Test Sig.svg", known);
    // File deleted upstream: metadata fetch returns nothing.
    const gone = deps(assetDir, []);
    upsertImportItem(db, "File:Test Sig.svg", "DISCOVERED");
    expect(await processDiscoveredFile(db, gone, "File:Test Sig.svg", known)).toBe("skipped");
    const { sql } = await import("drizzle-orm");
    const sigs = db.all<{ status: string }>(sql`SELECT status FROM signatures;`);
    expect(sigs[0].status).toBe("unavailable");
  });
});

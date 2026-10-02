/**
 * Seeds a demo database + asset mirror. Idempotent: re-runs are no-ops
 * (artist upsert + sha256 dedup + same-title source attach-skip).
 *
 *   bun examples/seed.ts [--db=./data/demo.sqlite] [--assets=./assets-demo]
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import {
  applyTakedown,
  approveResolution,
  createDb,
  findSourcesByTitle,
  insertSignatureFull,
  insertUnresolved,
  listPendingResolutions,
  migrateToLatest,
  upsertArtist,
} from "@artist-signatures/database";
import { normalizeName } from "@artist-signatures/resolver";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const dbPath = arg("db", "./data/demo.sqlite");
const assetDir = arg("assets", "./assets-demo");

const ADA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10" y="60" font-size="48">Ada</text></svg>`;
const TONES_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);

async function mirror(bytes: Uint8Array | string, ext: string): Promise<{ rel: string; sha256: string; size: number }> {
  const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const rel = join("signatures", sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.${ext}`);
  const full = join(assetDir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, buf);
  return { rel, sha256, size: buf.length };
}

const { db } = createDb(dbPath);
migrateToLatest(db, join(import.meta.dir, "../migrations"));

const ada = upsertArtist(
  db,
  { name: "Ada Melody", sortName: "Melody, Ada", musicbrainzId: "11111111-1111-1111-1111-111111111111", wikidataId: "Q999001", aliases: ["Ada M."] },
  normalizeName,
);
const tones = upsertArtist(
  db,
  { name: "The Test Tones", musicbrainzId: "22222222-2222-2222-2222-222222222222", aliases: ["Test Tones"] },
  normalizeName,
);

const adaMirror = await mirror(ADA_SVG, "svg");
insertSignatureFull(db, {
  artistId: ada.id,
  type: "handwritten",
  format: "svg",
  sha256: adaMirror.sha256,
  width: 200,
  height: 100,
  fileSize: adaMirror.size,
  assetUrl: adaMirror.rel,
  source: { provider: "wikimedia_commons", sourceTitle: "File:Ada Melody signature.svg", sourceUrl: "https://commons.wikimedia.org/wiki/File:Ada_Melody_signature.svg", originalUrl: "https://upload.wikimedia.org/wikipedia/commons/a/da.svg", sourceId: "9001", revisionId: "111" },
  license: { name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", status: "known" },
  resolution: { method: "wikidata_musicbrainz", confidence: 1, rawName: "Ada Melody", matchedArtistId: ada.id },
});

// Records without a sha256 can't dedup by content, so skip them when their
// source title is already present. This keeps re-runs exact no-ops.
const alreadySourced = (title: string): boolean =>
  findSourcesByTitle(db, "wikimedia_commons", title).length > 0;

// Unmirrored (license not `known` at import): metadata only, API falls back to original_url.
if (!alreadySourced("File:Ada Melody autograph.png")) {
  insertSignatureFull(db, {
    artistId: ada.id,
    type: "autograph",
    format: "png",
    source: { provider: "wikimedia_commons", sourceTitle: "File:Ada Melody autograph.png", sourceUrl: "https://commons.wikimedia.org/wiki/File:Ada_Melody_autograph.png", originalUrl: "https://upload.wikimedia.org/wikipedia/commons/a/autograph.png", sourceId: "9002", revisionId: "112" },
    license: { name: "Unknown", status: "unknown" },
    resolution: { method: "alias_match", confidence: 0.85, rawName: "Ada M.", matchedArtistId: ada.id },
  });
}

// Taken down: stays in the DB, hidden from public listing.
if (!alreadySourced("File:Test Tones old sig.svg")) {
  const td = insertSignatureFull(db, {
    artistId: tones.id,
    type: "handwritten",
    format: "svg",
    source: { provider: "wikimedia_commons", sourceTitle: "File:Test Tones old sig.svg", originalUrl: "https://upload.wikimedia.org/wikipedia/commons/t/old.svg", sourceId: "9003", revisionId: "113" },
    license: { name: "PD-signature", url: "https://commons.wikimedia.org/wiki/Template:PD-signature", status: "known" },
    resolution: { method: "musicbrainz_name_match", confidence: 0.95, rawName: "The Test Tones", matchedArtistId: tones.id },
  });
  applyTakedown(db, { signatureId: td.signatureId, reason: "demo takedown", requester: "demo@example.com" });
}

const alreadyParked =
  db.all<{ id: string }>(sql`SELECT id FROM unresolved_signatures WHERE raw_title = 'File:Mystery demo.svg';`).length > 0;
if (!alreadyParked) {
  insertUnresolved(db, {
    rawTitle: "File:Mystery demo.svg",
    description: "Signature of Mystery Demo",
    categories: ["Signatures", "Mystery Demo"],
    candidates: [{ name: "Mystery Demo", confidence: 0.5, method: "fuzzy_filename_match" }],
  });
}

// Approve Ada's confident match so the review queue shows exactly one item.
for (const p of listPendingResolutions(db, 100)) {
  if (p.resolution.confidence >= 0.95 && p.signature.artistId === ada.id) approveResolution(db, p.resolution.id, "seed");
}

console.log(JSON.stringify({ db: dbPath, assets: assetDir, artists: [ada.name, tones.name], pendingReview: listPendingResolutions(db, 100).length }, null, 2));

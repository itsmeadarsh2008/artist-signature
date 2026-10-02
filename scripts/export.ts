/**
 * Dataset snapshots (SPEC §39).
 *
 *   bun run scripts/export.ts --db=./data/signatures.sqlite --out=./dist/dataset \
 *     [--public-base-url=https://cdn.example.com] [--sqlite-out=./dist/signatures.sqlite]
 *
 * Writes artists.jsonl, signatures.jsonl, sources.jsonl, licenses.jsonl.
 * signatures.jsonl follows the SPEC §40 record shape and always carries the
 * per-record `license` + `source` — third-party assets keep their original
 * licenses; only this project's curation is CC BY 4.0 (LICENSE-CC).
 */

import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "@artist-signatures/database";

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const dbPath = arg("db", "./data/signatures.sqlite")!;
const outDir = arg("out", "./dist/dataset")!;
const publicBaseUrl = arg("public-base-url");
const sqliteOut = arg("sqlite-out");

const { db } = createDb(dbPath);

const artists = db.all<{
  id: string; name: string; sortName: string | null; musicbrainzId: string | null; wikidataId: string | null; normalizedName: string;
}>(sql`SELECT id, name, sort_name AS sortName, musicbrainz_id AS musicbrainzId, wikidata_id AS wikidataId, normalized_name AS normalizedName FROM artists ORDER BY id;`);
const aliases = db.all<{ artistId: string; alias: string }>(sql`SELECT artist_id AS artistId, alias FROM artist_aliases ORDER BY artist_id;`);
const signatures = db.all<{
  id: string; artistId: string | null; type: string; format: string; sha256: string | null; width: number | null; height: number | null;
  fileSize: number | null; assetUrl: string | null; status: string; verification: string;
}>(sql`SELECT id, artist_id AS artistId, type, format, sha256, width, height, file_size AS fileSize, asset_url AS assetUrl, status, verification FROM signatures ORDER BY id;`);
const sources = db.all(sql`SELECT * FROM sources ORDER BY id;`);
const licenses = db.all(sql`SELECT * FROM licenses ORDER BY id;`);

const aliasByArtist = new Map<string, string[]>();
for (const a of aliases) {
  const arr = aliasByArtist.get(a.artistId) ?? [];
  arr.push(a.alias);
  aliasByArtist.set(a.artistId, arr);
}
const artistById = new Map(artists.map((a) => [a.id, a]));
const sourcesBySig = new Map<string, unknown[]>();
for (const s of sources as { signature_id: string }[]) {
  const arr = sourcesBySig.get(s.signature_id) ?? [];
  arr.push(s);
  sourcesBySig.set(s.signature_id, arr);
}
const licensesBySig = new Map<string, unknown[]>();
for (const l of licenses as { signature_id: string }[]) {
  const arr = licensesBySig.get(l.signature_id) ?? [];
  arr.push(l);
  licensesBySig.set(l.signature_id, arr);
}

await mkdir(outDir, { recursive: true });
const lines = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");

await writeFile(
  join(outDir, "artists.jsonl"),
  lines(artists.map((a) => ({ id: a.id, name: a.name, sort_name: a.sortName, musicbrainz_id: a.musicbrainzId, wikidata_id: a.wikidataId, aliases: aliasByArtist.get(a.id) ?? [] }))),
);
await writeFile(join(outDir, "sources.jsonl"), lines(sources));
await writeFile(join(outDir, "licenses.jsonl"), lines(licenses));
await writeFile(
  join(outDir, "signatures.jsonl"),
  lines(
    signatures.map((s) => {
      const artist = s.artistId ? artistById.get(s.artistId) : undefined;
      const sigSources = (sourcesBySig.get(s.id) ?? []) as { provider: string; source_url: string | null; original_url: string | null }[];
      const sigLicenses = (licensesBySig.get(s.id) ?? []) as { name: string; url: string | null }[];
      const mirror = s.assetUrl && publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/v1/assets/${s.assetUrl}` : undefined;
      return {
        id: s.id,
        artist: artist ? { name: artist.name, musicbrainz_id: artist.musicbrainzId } : null,
        type: s.type,
        format: s.format,
        sha256: s.sha256,
        url: mirror ?? sigSources[0]?.original_url ?? undefined,
        status: s.status,
        verification: s.verification,
        source: sigSources[0] ? { provider: sigSources[0].provider, url: sigSources[0].source_url } : null,
        license: sigLicenses[0] ? { name: sigLicenses[0].name, url: sigLicenses[0].url } : null,
      };
    }),
  ),
);

if (sqliteOut) {
  // VACUUM INTO takes a consistent file-level snapshot for offline use.
  // It refuses an existing target, so clear last run's snapshot first.
  await rm(sqliteOut, { force: true });
  const raw = new Database(dbPath, { readonly: true });
  raw.exec(`VACUUM INTO '${sqliteOut.replace(/'/g, "''")}'`);
  raw.close();
  console.log(`sqlite snapshot: ${sqliteOut}`);
}
console.log(`wrote ${artists.length} artists, ${signatures.length} signatures to ${outDir}/`);

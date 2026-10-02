/**
 * Browser entry for serverless lookup. Bundled via:
 *   bun build examples/direct-entry.ts --target=browser --minify \
 *     --outfile=examples/vendor/direct.bundle.js
 *
 * Deliberately imports the fetch-only core (`@artist-signatures/direct`),
 * never the client index — the index pulls in `bun:sqlite` via `fromDataset`,
 * which cannot run in a browser.
 */
import { findLiveRecords } from "../packages/direct/src/index";

export interface DirectSignature {
  id: string;
  asset: { url?: string; format: string; type: string };
  source: { provider: string; url?: string | null } | null;
  license: { name: string };
  verification: string;
}

export interface DirectLookupResult {
  artist: { name: string; musicbrainz_id?: string };
  signatures: DirectSignature[];
}

export async function lookupDirect(name: string, format?: string): Promise<DirectLookupResult> {
  const { artist, items } = await findLiveRecords(name);
  if (items.length === 0) {
    const err = new Error("No artist was found for the supplied name.") as Error & { code: string; status: number };
    err.code = "ARTIST_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  let signatures = items.map((i) => i.record);
  if (format) signatures = signatures.filter((s) => s.asset.format === format);
  if (signatures.length === 0) {
    const err = new Error("No signature matches the supplied filters.") as Error & { code: string; status: number };
    err.code = "SIGNATURE_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  return { artist: { name: artist.name, musicbrainz_id: artist.musicbrainzId }, signatures };
}

// Bundle entry point: the page loads this file, not the module graph.
(window as unknown as { ArtistDirect: { lookupDirect: typeof lookupDirect } }).ArtistDirect = {
  lookupDirect,
};

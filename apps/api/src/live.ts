/**
 * Live Commons lookup for names not yet in the database.
 *
 * The database is populated by crawls, but a name that was never crawled would
 * otherwise 404 forever. This module performs an on-demand, read-only search of
 * Wikimedia Commons for signature files of that artist and imports just those
 * records (metadata + license + provenance), so the same identity/provenance
 * rules apply to live hits as to crawled ones (SPEC §11, §12, §66).
 *
 * Discovery and filtering live in `@artist-signatures/direct` (shared with the
 * serverless client and the browser demo); this module only adds persistence.
 *
 * Assets are NOT downloaded: `asset_url` stays null and the API serves the
 * upstream original URL (SPEC §49).
 */

import { normalizeName } from "@artist-signatures/resolver";
import { classifyType, findLiveRecords, formatOf, LIVE_PROVIDER, type DirectDeps } from "@artist-signatures/direct";
import { findSourcesByTitle, insertSignatureFull, upsertArtist, type Db } from "@artist-signatures/database";

export interface LiveLookupDeps extends DirectDeps {
  fetchWikidata?: never;
}

/**
 * Imports signatures for `name` if they are missing. Idempotent: records whose
 * Commons source title is already stored are skipped (SPEC §24).
 * Returns the number of newly imported signatures.
 */
export async function importLiveSignatures(db: Db, name: string, deps: LiveLookupDeps = {}): Promise<number> {
  const { artist, items } = await findLiveRecords(name, deps);
  if (items.length === 0) return 0;

  const row = upsertArtist(
    db,
    { name: artist.name, musicbrainzId: artist.musicbrainzId, aliases: artist.musicbrainzId ? [] : [name] },
    normalizeName,
  );
  const method = artist.musicbrainzId ? "musicbrainz_name_match" : "normalized_filename_match";
  const confidence = artist.musicbrainzId ? 0.95 : 0.7;

  let imported = 0;
  for (const { parsed } of items) {
    if (findSourcesByTitle(db, LIVE_PROVIDER, parsed.title).length > 0) continue;
    insertSignatureFull(db, {
      artistId: row.id,
      type: classifyType(parsed.title, parsed.description ?? "", parsed.categories),
      format: formatOf(parsed.mime),
      width: parsed.width,
      height: parsed.height,
      fileSize: parsed.fileSize,
      // No mirror: consumers use the upstream original URL (SPEC §49).
      source: {
        provider: LIVE_PROVIDER,
        sourceUrl: parsed.sourceUrl,
        originalUrl: parsed.originalUrl,
        sourceTitle: parsed.title,
        sourceId: parsed.pageId !== undefined ? String(parsed.pageId) : undefined,
      },
      license: { name: parsed.license.name, url: parsed.license.url, usageTerms: parsed.license.usageTerms, status: parsed.license.status },
      resolution: {
        method,
        confidence,
        rawName: parsed.artist ?? name,
        matchedArtistId: row.id,
      },
    });
    imported++;
  }
  return imported;
}

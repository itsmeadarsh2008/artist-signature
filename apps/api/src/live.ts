/**
 * Live Commons lookup for names not yet in the database.
 *
 * The database is populated by crawls, but a name that was never crawled would
 * otherwise 404 forever. This module performs an on-demand, read-only search of
 * Wikimedia Commons for signature files of that artist and imports just those
 * records (metadata + license + provenance), so the same identity/provenance
 * rules apply to live hits as to crawled ones (SPEC §11, §12, §66).
 *
 * Assets are NOT downloaded: `asset_url` stays null and the API serves the
 * upstream original URL (SPEC §49).
 */

import { parseCommonsFile, type CommonsFileInput } from "@artist-signatures/parser";
import { normalizeName } from "@artist-signatures/resolver";
import { findSourcesByTitle, insertSignatureFull, upsertArtist, type Db } from "@artist-signatures/database";
import { CommonsClient } from "../../importer/src/wikimedia";
import { searchMusicBrainzArtist } from "../../importer/src/musicbrainz";

export const LIVE_PROVIDER = "wikimedia_commons";

export interface LiveLookupDeps {
  client?: Pick<CommonsClient, "get" | "categoryMembers" | "fetchFileMetadata">;
  lookupMusicBrainz?: (name: string) => Promise<{ id: string; name: string; sortName?: string; aliases?: string[] } | undefined>;
  /** Cap on candidates pulled from Commons. Default 25. */
  maxCandidates?: number;
  maxFilesImported?: number;
  fetchWikidata?: never;
}

const MIME_TO_FORMAT: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

const formatOf = (mime?: string): string => (mime ? (MIME_TO_FORMAT[mime.split(";")[0].trim()] ?? "other") : "other");

/**
 * Candidate files for one artist:
 *  1. the predictable `Category:Signatures of <name>` (precise when it exists)
 *  2. a Commons full-text search, narrowed to the File namespace
 */
async function candidateTitles(client: NonNullable<LiveLookupDeps["client"]>, name: string, limit: number): Promise<string[]> {
  const titles = new Set<string>();
  const category = `Category:Signatures of ${name}`;
  try {
    for await (const m of client.categoryMembers(category, "file")) {
      if (m.kind === "file") titles.add(m.title);
      if (titles.size >= limit) break;
    }
  } catch {
    // Category may not exist; fall through to search.
  }
  if (titles.size < limit) {
    try {
      const data = (await client.get({
        action: "query",
        list: "search",
        srsearch: `"${name}" signature`,
        srnamespace: "6",
        srlimit: String(limit),
      })) as { query?: { search?: { title: string }[] } };
      for (const hit of data.query?.search ?? []) titles.add(hit.title);
    } catch {
      // Search unavailable; whatever the category yielded is still usable.
    }
  }
  return [...titles].slice(0, limit);
}

/**
 * Candidate acceptance: is this file a signature *of the queried artist*?
 *
 * Three things learned from real Commons data drove this design:
 *  - Full-text search returns photos, logos, and album covers that merely
 *    mention the artist ("Baby Taylor", "Brand Universe"), so a bare mention of
 *    the name must never be enough.
 *  - `normalizeName` deliberately strips signature words ("Signatures of X" ->
 *    "x", "Dua Lipa (nënshkrim).svg" -> "dua lipa"), so hints must be located in
 *    RAW text; normalization is used only to compare the artist's name.
 *  - The artist's name can sit before or after the signature word, separated by
 *    any amount of connective prose ("Ed Sheeran's official signature",
 *    "Firma Taylor Swift", "sig of Ed Sheeran"), so proximity is measured
 *    within a window rather than by a fixed phrase pattern.
 */
const raw = (value?: string): string => (value ?? "").toLowerCase();

/** Signature-ish wording across the languages Commons actually uses. */
const SIGNATURE_HINT_SOURCE =
  "signature|signaturen|autograph|unterschrift|firmen|firma|n[eë]nshkrim|monogram|initial|\\bsig\\b|\\bsign\\b";
const SIGNATURE_HINT = new RegExp(SIGNATURE_HINT_SOURCE, "i");

/** Builds a name matcher tolerant of apostrophes/dots/spaces inside the name. */
function nameMatcher(name: string): RegExp {
  const tokens = name.toLowerCase().split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return /$^/;
  const body = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s'’.\\-_]{0,4}");
  return new RegExp(`(?<![\\p{L}])${body}(?![\\p{L}])`, "iu");
}

/**
 * True when a signature hint occurs within `window` chars of the artist's name.
 *
 * Uses one global regex over the whole string and advances via `lastIndex`.
 * (Slicing per iteration and reading `hit.index` would be relative to the
 * slice, so the cursor can stall and the loop never terminate.)
 */
const HINT_SCAN = new RegExp(SIGNATURE_HINT_SOURCE, "gi");

function signatureNearName(text: string, nameRe: RegExp, window = 80): boolean {
  HINT_SCAN.lastIndex = 0;
  for (let hit = HINT_SCAN.exec(text); hit !== null; hit = HINT_SCAN.exec(text)) {
    const start = hit.index;
    const lo = Math.max(0, start - window);
    const hi = Math.min(text.length, start + hit[0].length + window);
    nameRe.lastIndex = 0;
    if (nameRe.test(text.slice(lo, hi))) return true;
    // Zero-length matches cannot happen here, but guard against a stall.
    if (HINT_SCAN.lastIndex <= start) HINT_SCAN.lastIndex = start + 1;
  }
  return false;
}

/**
 * Categories are the strongest signal — but only when they name the artist.
 *
 * Real-data counterexamples that forced the strictness:
 *   - `File:Taylor Swift Baby Taylor ...jpg` is a photo of a GUITAR whose model
 *     line is called "Signature", filed under `Signature guitar models`.
 *   - `File:Taylor Swift Brand Universe.png` is a logo sheet whose description
 *     mentions the artist's signature.
 * So a category counts when it contains a signature hint AND names the queried
 * artist ("Signatures of Dua Lipa"). A hint-only category never qualifies.
 */
function isSignatureCategory(categories: string[], nameRe: RegExp, normalizedQuery: string): boolean {
  return categories.some((c) => SIGNATURE_HINT.test(raw(c)) && nameRe.test(raw(c)));
}

function looksLikeArtistSignature(
  parsed: ReturnType<typeof parseCommonsFile>,
  normalizedQuery: string,
  nameRe: RegExp,
): boolean {
  if (isSignatureCategory(parsed.categories, nameRe, normalizedQuery)) return true;
  return signatureNearName(`${raw(parsed.title)} ${raw(parsed.description)}`, nameRe);
}

/** Metadata-based classification, mirroring the importer (SPEC §18). */
function classifyType(title: string, description: string, categories: string[]): string {
  const hay = `${title} ${description} ${categories.join(" ")}`.toLowerCase();
  if (/monogram/.test(hay)) return "monogram";
  if (/initials?/.test(hay)) return "initials";
  if (/digital/.test(hay)) return "digital";
  if (/autograph/.test(hay)) return "autograph";
  if (/signature/.test(hay)) return "handwritten";
  return "unknown";
}

/**
 * Imports signatures for `name` if they are missing. Idempotent: records whose
 * Commons source title is already stored are skipped (SPEC §24).
 * Returns the number of newly imported signatures.
 */
export async function importLiveSignatures(db: Db, name: string, deps: LiveLookupDeps = {}): Promise<number> {
  const client = deps.client ?? new CommonsClient();
  const limit = deps.maxCandidates ?? 25;
  const maxImport = deps.maxFilesImported ?? 5;
  const normalized = normalizeName(name);
  if (normalized === "") return 0;
  const nameRe = nameMatcher(name);

  const candidates = await candidateTitles(client, name, limit);
  if (candidates.length === 0) return 0;

  const pages = await client.fetchFileMetadata(candidates);

  // Parse first, then decide identity: MusicBrainz is only consulted when at
  // least one plausible signature file exists.
  const usable = pages
    .map((p: CommonsFileInput) => parseCommonsFile(p))
    .filter((p) => {
      if (p.mime && formatOf(p.mime) === "other") return false;
      return looksLikeArtistSignature(p, normalized, nameRe);
    })
    .filter((p) => p.license.status !== "restricted")
    // Prefer redistributable + vector, so the first result is the most useful.
    .sort((a, b) => {
      const rank = (p: typeof a) =>
        (p.license.status === "known" ? 0 : 1) * 10 + (formatOf(p.mime) === "svg" ? 0 : 1);
      return rank(a) - rank(b) || a.title.localeCompare(b.title);
    });

  if (usable.length === 0) return 0;

  const lookupMb = deps.lookupMusicBrainz ?? searchMusicBrainzArtist;
  let artist = { id: undefined as string | undefined, name, musicbrainzId: undefined as string | undefined };
  try {
    const mb = await lookupMb(name);
    if (mb) artist = { id: mb.id, name: mb.name, musicbrainzId: mb.id };
  } catch {
    // Identity lookup failure degrades to a name-only artist, never fatal.
  }

  const row = upsertArtist(
    db,
    { name: artist.name, musicbrainzId: artist.musicbrainzId, aliases: artist.musicbrainzId ? [] : [name] },
    normalizeName,
  );

  let imported = 0;
  for (const parsed of usable.slice(0, maxImport)) {
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
        method: artist.musicbrainzId ? "musicbrainz_name_match" : "normalized_filename_match",
        confidence: artist.musicbrainzId ? 0.95 : 0.7,
        rawName: parsed.artist ?? name,
        matchedArtistId: row.id,
      },
    });
    imported++;
  }
  return imported;
}
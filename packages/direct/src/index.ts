/**
 * Direct (serverless, database-free) signature lookup.
 *
 * Pure fetch-only logic: search Wikimedia Commons for an artist's signature
 * files, parse + filter + resolve identity, and return API-shaped records.
 * No SQLite, no node APIs — this module bundles for the browser as-is and is
 * shared by the API live path (`apps/api/src/live.ts`), the client library
 * (`ArtistSignatures.direct()`), and the browser demo.
 *
 * The Commons/MusicBrainz adapters live in `apps/importer` (SPEC §56 keeps
 * source-specific logic isolated) and are imported relatively so there is a
 * single implementation for server, library, and browser consumers.
 */

import { parseCommonsFile, type CommonsFileInput, type ParsedCommonsFile } from "@artist-signatures/parser";
import { bestSignature, normalizeName } from "@artist-signatures/resolver";
import { CommonsClient } from "../../../apps/importer/src/wikimedia";
import { searchMusicBrainzArtist } from "../../../apps/importer/src/musicbrainz";

export const LIVE_PROVIDER = "wikimedia_commons";

export interface DirectDeps {
  client?: Pick<CommonsClient, "get" | "categoryMembers" | "fetchFileMetadata">;
  lookupMusicBrainz?: (name: string) => Promise<{ id: string; name: string; sortName?: string; aliases?: string[] } | undefined>;
  /** Cap on candidates pulled from Commons. Default 25. */
  maxCandidates?: number;
  maxFilesImported?: number;
}

export interface DirectArtist {
  name: string;
  musicbrainzId?: string;
}

/** API-shaped record (mirrors the REST `signature` object). No database id. */
export interface DirectSignatureRecord {
  id: string;
  artist: { name: string; musicbrainz_id?: string; wikidata_id?: string } | null;
  asset: {
    url?: string;
    format: string;
    type: string;
    width?: number | null;
    height?: number | null;
    sha256?: string | null;
  };
  source: { provider: string; url?: string | null; original_url?: string | null } | null;
  license: { name: string; url?: string | null; status?: string | null };
  verification: "unverified";
}

export interface LiveItem {
  parsed: ParsedCommonsFile;
  record: DirectSignatureRecord;
}

export interface LiveResult {
  artist: DirectArtist;
  items: LiveItem[];
}

const MIME_TO_FORMAT: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

export const formatOf = (mime?: string): string =>
  mime ? (MIME_TO_FORMAT[mime.split(";")[0].trim()] ?? "other") : "other";

/**
 * Candidate files for one artist:
 *  1. the predictable `Category:Signatures of <name>` (precise when it exists)
 *  2. a Commons full-text search, narrowed to the File namespace
 */
async function candidateTitles(
  client: NonNullable<DirectDeps["client"]>,
  name: string,
  limit: number,
): Promise<string[]> {
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
  const tokens = name
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== "");
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
export function classifyType(title: string, description: string, categories: string[]): string {
  const hay = `${title} ${description} ${categories.join(" ")}`.toLowerCase();
  if (/monogram/.test(hay)) return "monogram";
  if (/initials?/.test(hay)) return "initials";
  if (/digital/.test(hay)) return "digital";
  if (/autograph/.test(hay)) return "autograph";
  if (/signature/.test(hay)) return "handwritten";
  return "unknown";
}

/** API-shaped signature as served by the REST API, the dataset transport, or findLiveRecords. */
export interface ShapedSignature {
  id: string;
  asset?: { url?: string | null; format?: string | null; type?: string | null } | null;
  source?: { url?: string | null; original_url?: string | null } | null;
  license?: { name?: string | null; status?: string | null } | null;
  verification?: string | null;
}

/**
 * Best-first pick over API-shaped records (whatever transport produced them).
 * Returns the winning record id, or null when nothing is servable. The page
 * uses it to badge the best card; ranking logic itself stays in the resolver
 * so every consumer shares one implementation.
 */
export function pickBest(signatures: ShapedSignature[]): string | null {
  if (signatures.length === 0) return null;
  const top = bestSignature(
    signatures.map((s) => ({
      signature: {
        id: s.id,
        type: s.asset?.type ?? null,
        format: s.asset?.format ?? null,
        status: "available",
        verification: s.verification ?? null,
      },
      licenses: s.license ? [{ status: s.license.status ?? null }] : [],
      source: s.source
        ? { original_url: s.source.original_url ?? null, source_url: s.source.url ?? null }
        : null,
      resolutions: [],
    })),
  );
  return top ? top.signature.id : null;
}

/** Stable client-side id derived from the upstream page id (no database). */
function liveId(pageId: number | undefined, title: string): string {
  if (pageId !== undefined) return `live-${pageId}`;
  let hash = 5381;
  for (let i = 0; i < title.length; i++) hash = ((hash << 5) + hash + title.charCodeAt(i)) | 0;
  return `live-h${(hash >>> 0).toString(36)}`;
}

function toRecord(parsed: ParsedCommonsFile, artist: DirectArtist): DirectSignatureRecord {
  return {
    id: liveId(parsed.pageId, parsed.title),
    artist: { name: artist.name, musicbrainz_id: artist.musicbrainzId },
    asset: {
      // No mirror: consumers use the upstream original URL (SPEC §49).
      url: parsed.originalUrl,
      format: formatOf(parsed.mime),
      type: classifyType(parsed.title, parsed.description ?? "", parsed.categories),
      width: parsed.width ?? null,
      height: parsed.height ?? null,
      sha256: null,
    },
    source: {
      provider: LIVE_PROVIDER,
      url: parsed.sourceUrl ?? null,
      original_url: parsed.originalUrl ?? null,
    },
    license: { name: parsed.license.name, url: parsed.license.url ?? null, status: parsed.license.status },
    verification: "unverified",
  };
}

/**
 * Finds signature records for `name` straight from upstream sources.
 * No database, no downloads — safe to call from a browser.
 */
export async function findLiveRecords(name: string, deps: DirectDeps = {}): Promise<LiveResult> {
  const client = deps.client ?? new CommonsClient();
  const limit = deps.maxCandidates ?? 25;
  const maxFiles = deps.maxFilesImported ?? 5;
  const normalized = normalizeName(name);
  const empty: LiveResult = { artist: { name }, items: [] };
  if (normalized === "") return empty;
  const nameRe = nameMatcher(name);

  const candidates = await candidateTitles(client, name, limit);
  if (candidates.length === 0) return empty;

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

  if (usable.length === 0) return empty;

  const lookupMb = deps.lookupMusicBrainz ?? searchMusicBrainzArtist;
  const artist: DirectArtist = { name };
  try {
    const mb = await lookupMb(name);
    if (mb) {
      artist.name = mb.name;
      artist.musicbrainzId = mb.id;
    }
  } catch {
    // Identity lookup failure degrades to a name-only artist, never fatal.
  }
  return {
    artist,
    items: usable.slice(0, maxFiles).map((parsed) => ({
      parsed,
      record: toRecord(parsed, artist),
    })),
  };
}

/**
 * Artist resolver (SPEC §3.2, §12-16, §55).
 *
 * Turns a parsed Commons file into a canonical artist using multiple
 * signals. Never assumes the filename is the identity; every match carries
 * a confidence score and method. Thresholds are configurable (SPEC §16).
 */

import { normalizeName, stripFilenameBoilerplate } from "./normalize";

export { normalizeName, stripFilenameBoilerplate };

/** Minimal structural input: any ParsedCommonsFile satisfies this. */
export interface ResolvableFile {
  title: string;
  artist?: string;
  categories: string[];
  wikidataId?: string;
}

export interface KnownArtist {
  id?: string;
  name: string;
  sortName?: string;
  musicbrainzId?: string;
  wikidataId?: string;
  aliases?: string[];
}

export interface ResolutionCandidate {
  artist: KnownArtist;
  confidence: number;
  method: string;
  rawName: string;
}

export type ResolutionStatus = "accepted" | "review" | "unresolved";

export interface ArtistResolution {
  artist: KnownArtist | null;
  confidence: number;
  method: string;
  candidates: ResolutionCandidate[];
  status: ResolutionStatus;
}

export interface ResolveOptions {
  /** >= acceptThreshold -> automatically accept. Default 0.90 (SPEC §16). */
  acceptThreshold?: number;
  /** >= reviewThreshold -> human review queue. Default 0.70 (SPEC §16). */
  reviewThreshold?: number;
  /** Minimum similarity for a fuzzy filename match. Default 0.85. */
  fuzzyFloor?: number;
}

/** Levenshtein-based similarity in [0, 1]. */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = longer === a ? b : a;
  if (longer.length === 0) return 1;
  let prev = Array.from({ length: shorter.length + 1 }, (_, i) => i);
  for (let i = 1; i <= longer.length; i++) {
    const curr = [i];
    for (let j = 1; j <= shorter.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (longer[i - 1] === shorter[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return 1 - prev[shorter.length] / longer.length;
}

const eq = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

interface RawSignal {
  raw: string;
  kind: "hint" | "filename" | "category";
}

/** Candidate name strings from filename, description hint, and categories. */
export function candidateSignals(file: ResolvableFile): RawSignal[] {
  const out: RawSignal[] = [];
  if (file.artist) out.push({ raw: file.artist, kind: "hint" });
  const fromTitle = stripFilenameBoilerplate(file.title);
  if (fromTitle !== "") out.push({ raw: fromTitle, kind: "filename" });
  for (const category of file.categories) {
    const person = stripFilenameBoilerplate(category)
      .replace(/^(signatures?|autographs?)\s+of\s+/i, "")
      .trim();
    if (person !== "") out.push({ raw: person, kind: "category" });
  }
  return out;
}

export function resolveArtist(
  file: ResolvableFile,
  knownArtists: KnownArtist[],
  opts: ResolveOptions = {},
): ArtistResolution {
  const acceptThreshold = opts.acceptThreshold ?? 0.9;
  const reviewThreshold = opts.reviewThreshold ?? 0.7;
  const fuzzyFloor = opts.fuzzyFloor ?? 0.85;

  const signals = candidateSignals(file);
  const candidates: ResolutionCandidate[] = [];

  for (const artist of knownArtists) {
    let best: ResolutionCandidate | null = null;
    const consider = (confidence: number, method: string, rawName: string) => {
      if (!best || confidence > best.confidence) best = { artist, confidence, method, rawName };
    };

    // SPEC §16: Wikidata + MusicBrainz ID -> 1.00.
    if (file.wikidataId && artist.wikidataId && eq(file.wikidataId, artist.wikidataId)) {
      if (artist.musicbrainzId) {
        consider(1.0, "wikidata_musicbrainz", file.wikidataId);
      } else {
        consider(0.9, "wikidata", file.wikidataId);
      }
    }

    for (const { raw, kind } of signals) {
      // Exact name: confidence depends on the identity backing (SPEC §16).
      if (eq(raw, artist.name)) {
        const c = artist.musicbrainzId ? 0.95 : artist.wikidataId ? 0.9 : 0.8;
        const method = kind === "category" ? "category_match" : artist.musicbrainzId ? "musicbrainz_name_match" : "exact_name_match";
        consider(kind === "category" ? Math.min(c, 0.8) : c, method, raw);
      }
      for (const alias of artist.aliases ?? []) {
        if (eq(raw, alias)) consider(0.85, "alias_match", raw);
      }
      // Normalized filename match -> 0.70 (SPEC §16).
      if (kind === "filename") {
        const names = [artist.name, ...(artist.aliases ?? [])];
        if (names.some((n) => normalizeName(raw) === normalizeName(n))) {
          consider(0.7, "normalized_filename_match", raw);
        } else if (stringSimilarity(normalizeName(raw), normalizeName(artist.name)) >= fuzzyFloor) {
          consider(0.5, "fuzzy_filename_match", raw);
        }
      }
    }

    if (best) candidates.push(best);
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const top = candidates[0];

  if (!top || top.confidence < reviewThreshold) {
    return { artist: null, confidence: top?.confidence ?? 0, method: top?.method ?? "no_match", candidates, status: "unresolved" };
  }
  return {
    artist: top.artist,
    confidence: top.confidence,
    method: top.method,
    candidates,
    status: top.confidence >= acceptThreshold ? "accepted" : "review",
  };
}

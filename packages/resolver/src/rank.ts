/**
 * Ranking: which artist did the user mean, and which signature is best.
 *
 * Pure functions, no I/O — shared by the database search, the client, and the
 * browser bundle. Inputs are structural (not Drizzle rows) so this module
 * stays free of `bun:sqlite` and bundles for the browser.
 */

import { normalizeName } from "./normalize";
import { stringSimilarity } from "./index";

export interface MatchScore {
  /** 0 = no match; higher wins. Calibrated so exact > prefix > tokens > fuzzy. */
  score: number;
  /** Which signal produced the score (debugging/explainability). */
  via:
    | "exact_name"
    | "exact_alias"
    | "prefix"
    | "tokens"
    | "token_prefix"
    | "fuzzy"
    | "none";
}

const tokensOf = (normalized: string): string[] =>
  normalized.split(/\s+/).filter((t) => t !== "");

/**
 * Score one normalized candidate name against a normalized query.
 * Also tests each alias; the best signal wins.
 */
export function scoreArtistMatch(
  normalizedQuery: string,
  normalizedName: string,
  normalizedAliases: string[] = [],
): MatchScore {
  const none: MatchScore = { score: 0, via: "none" };
  const q = normalizedQuery.trim();
  if (q === "") return none;
  const names = [normalizedName, ...normalizedAliases];
  let best: MatchScore = none;

  for (const candidate of names) {
    const isAlias = candidate !== normalizedName;
    if (q === candidate) {
      const s: MatchScore = { score: isAlias ? 90 : 100, via: isAlias ? "exact_alias" : "exact_name" };
      if (s.score > best.score) best = s;
      continue;
    }
    if (candidate.startsWith(q)) {
      if (80 > best.score) best = { score: 80, via: "prefix" };
    }
    const qTokens = tokensOf(q);
    const cTokens = tokensOf(candidate);
    if (qTokens.length > 0 && qTokens.every((t) => cTokens.includes(t))) {
      if (70 > best.score) best = { score: 70, via: "tokens" };
    }
    if (
      qTokens.length > 0 &&
      qTokens.every((t) => cTokens.some((c) => c.startsWith(t) && c !== t))
    ) {
      if (60 > best.score) best = { score: 60, via: "token_prefix" };
    }
    // Typo tolerance: best token-level similarity, plus whole-name similarity
    // for short queries where token evidence is thin.
    let sim = 0;
    for (const qt of qTokens) {
      for (const ct of cTokens) {
        if (Math.abs(qt.length - ct.length) > 3) continue;
        const s = stringSimilarity(qt, ct);
        if (s > sim) sim = s;
      }
    }
    if (sim >= 0.8) {
      const s = Math.round(30 + sim * 25);
      if (s > best.score) best = { score: s, via: "fuzzy" };
    } else {
      const whole = stringSimilarity(q, candidate);
      if (whole >= 0.85) {
        const s = Math.round(30 + whole * 20);
        if (s > best.score) best = { score: s, via: "fuzzy" };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Signature ranking: which record should an app render first.
// ---------------------------------------------------------------------------

/** Structural subset of a full signature record (Drizzle rows satisfy this). */
export interface RankableSignature {
  signature: {
    id: string;
    type?: string | null;
    format?: string | null;
    status?: string | null;
    verification?: string | null;
    width?: number | null;
    height?: number | null;
  };
  licenses?: { status?: string | null }[] | null;
  sources?: { originalUrl?: string | null; sourceUrl?: string | null; original_url?: string | null; source_url?: string | null }[] | null;
  source?: { originalUrl?: string | null; sourceUrl?: string | null; original_url?: string | null; source_url?: string | null } | null;
  resolutions?: { confidence?: number | null }[] | null;
}

export interface RankOptions {
  /** Excluded by default: never surface retracted records as "best". */
  includeUnavailable?: boolean;
  /** Restricted-license records sort last unless they are all there is. */
  includeRestricted?: boolean;
}

const FORMAT_SCORE: Record<string, number> = { svg: 30, png: 20, webp: 15, jpeg: 10 };
const TYPE_SCORE: Record<string, number> = {
  handwritten: 10,
  autograph: 10,
  digital: 5,
  monogram: 5,
  initials: 5,
};
const VERIFICATION_SCORE: Record<string, number> = { artist_verified: 30, verified: 20 };

function licenseStatuses(s: RankableSignature): string[] {
  const fromList = (s.licenses ?? []).map((l) => l.status).filter((x): x is string => !!x);
  return fromList;
}

function hasUrl(s: RankableSignature): boolean {
  const all = [...(s.sources ?? []), ...(s.source ? [s.source] : [])];
  return all.some((x) => x.originalUrl ?? x.original_url ?? x.sourceUrl ?? x.source_url);
}

/**
 * Panoramic-crop bonus: a wide image is usually a complete signature line,
 * while near-square canvases are often fragments with empty whitespace.
 * Capped so it breaks ties but never outweighs license, format, or
 * verification. No penalty for tall images — only wide ones earn it.
 */
function panoramaBonus(width?: number | null, height?: number | null): number {
  if (!width || !height || height <= 0) return 0;
  const aspect = width / height;
  if (aspect <= 1.5) return 0;
  return Math.min(15, Math.round((aspect - 1.5) * 5));
}

/** Higher wins. Deterministic: ties break on record id. */
export function scoreSignature(s: RankableSignature): number {
  const statuses = licenseStatuses(s);
  const restricted = statuses.includes("restricted");
  let score = 0;
  if (restricted) score -= 500;
  else if (statuses.includes("known")) score += 100;
  else if (statuses.includes("requires_review")) score += 20;
  else if (statuses.includes("unknown")) score += 10;
  score += FORMAT_SCORE[s.signature.format ?? "other"] ?? 0;
  score += VERIFICATION_SCORE[s.signature.verification ?? "unverified"] ?? 0;
  score += TYPE_SCORE[s.signature.type ?? "unknown"] ?? 0;
  const confidences = (s.resolutions ?? []).map((r) => r.confidence ?? 0);
  if (confidences.length > 0) score += Math.round(Math.max(...confidences) * 20);
  if (hasUrl(s)) score += 5;
  if (s.signature.width != null && s.signature.height != null) score += 5;
  score += panoramaBonus(s.signature.width, s.signature.height);
  return score;
}

/** Best-first ordering; ties break on id so pagination is stable. */
export function rankSignatures<T extends RankableSignature>(items: T[], opts: RankOptions = {}): T[] {
  // Unavailable records are never servable: hard filter, no fallback.
  const eligible = opts.includeUnavailable ? items : items.filter((i) => (i.signature.status ?? "available") === "available");
  // Restricted licenses sort last, but win when they are all there is.
  const pool = opts.includeRestricted ? eligible : eligible.filter((i) => !licenseStatuses(i).includes("restricted"));
  const ranked = (pool.length > 0 ? pool : eligible).map((item) => ({ item, score: scoreSignature(item) }));
  ranked.sort((a, b) => b.score - a.score || a.item.signature.id.localeCompare(b.item.signature.id));
  return ranked.map((r) => r.item);
}

/**
 * The single signature an app should render. Undefined when nothing is
 * servable — callers turn that into SIGNATURE_NOT_FOUND.
 */
export function bestSignature<T extends RankableSignature>(items: T[], opts: RankOptions = {}): T | undefined {
  return rankSignatures(items, opts)[0];
}

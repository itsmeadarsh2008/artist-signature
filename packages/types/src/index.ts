/**
 * Shared domain types for artist-signatures (SPEC §22, §40, §44).
 *
 * These types describe the source-agnostic data model (SPEC §57):
 * signature -> source -> provider, with per-record license metadata.
 * Third-party assets keep their original licenses; nothing here relicenses them.
 */

export type SignatureType =
  | "handwritten"
  | "autograph"
  | "digital"
  | "monogram"
  | "initials"
  | "unknown";

export type SignatureFormat = "svg" | "png" | "jpeg" | "webp" | "other";

/** SPEC §10. Never assume a file is free to redistribute. */
export type LicenseStatus = "known" | "unknown" | "restricted" | "requires_review";

export interface LicenseInfo {
  name: string;
  url?: string;
  usageTerms?: string;
  attributionRequired?: boolean;
  status: LicenseStatus;
  /** Where the license statement came from, e.g. "wikimedia". */
  source: string;
}

/** SPEC §11. The original page must remain available even if mirrored. */
export interface SourceInfo {
  /** e.g. "wikimedia_commons". Must not be assumed; see SPEC §57. */
  provider: string;
  /** e.g. "File:Dua Lipa (nënshkrim).svg" for Wikimedia sources. */
  fileTitle?: string;
  /** Human-readable source page, e.g. the Commons description page. */
  pageUrl?: string;
  /** Direct URL of the original asset. */
  originalUrl?: string;
  /** Upstream page/file identifier, e.g. Commons pageid. */
  sourceId?: string;
  /** Upstream revision at import time. */
  revisionId?: string;
  importedAt?: string;
  /** SPEC §25: deleted upstream files become unavailable, never deleted. */
  status?: "available" | "unavailable";
}

export interface ArtistRef {
  name: string;
  musicbrainzId?: string;
  wikidataId?: string;
}

/** SPEC §41. Describes record provenance confidence, not autograph authenticity. */
export type VerificationState = "unverified" | "verified" | "artist_verified";

export interface SignatureRecord {
  id: string;
  artist: ArtistRef;
  type: SignatureType;
  format: SignatureFormat;
  /** SHA-256 of asset bytes; canonical content identifier (SPEC §20-21). */
  sha256?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  /** Served asset URL (CDN or mirror). */
  url: string;
  source: SourceInfo;
  license: LicenseInfo;
  verification?: VerificationState;
}

/** SPEC §22.6. Preserves why an artist was matched. */
export interface ResolutionRecord {
  method: string;
  confidence: number;
  rawName?: string;
  matchedArtistId?: string;
  reviewed: boolean;
}

/** SPEC §47. */
export type ApiErrorCode =
  | "ARTIST_NOT_FOUND"
  | "SIGNATURE_NOT_FOUND"
  | "INVALID_REQUEST"
  | "INVALID_FORMAT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

/**
 * Minimal fetch shape used across Commons/MusicBrainz adapters and transports.
 * Deliberately narrower than `typeof fetch` (whose Bun flavor carries a
 * non-standard `preconnect` member no plain function can satisfy), and narrow
 * enough that any `(url, init?) => Promise<Response>` — including a receiver-
 * bound wrapper, which browsers require — is assignable.
 */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

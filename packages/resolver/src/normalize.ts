/**
 * Single shared name-normalization function (SPEC §15).
 * Used by both the importer and the API: the same input must normalize
 * identically on both sides. The original name is never destroyed;
 * callers store both `original_name` and `normalized_name`.
 */

/** Filename tokens that carry no identity: "File:X signature.svg" -> "X". */
const FILENAME_PREFIXES = /^(file|image|datei|fichier|archivo)\s*:\s*/i;
const FILENAME_EXTENSIONS = /\.(svg|png|jpe?g|webp|gif|tiff?|bmp|pdf)$/i;
/** Standalone words stripped only at the edges: "Signature of X" keeps X. */
const EDGE_NOISE_WORDS = /^(signature|signatures|autograph|autographs|signed|autogramm|unterschrift|n[eë]nshkrim|firma)s?\b|\b(signature|signatures|autograph|autographs|signed)\s*$/i;
const PARENTHETICAL_NOISE = /\((signature|signatures|autograph|autographs|signed|n[eë]nshkrim|unterschrift)\)/gi;

export function stripFilenameBoilerplate(raw: string): string {
  let s = raw.trim();
  s = s.replace(FILENAME_PREFIXES, "");
  s = s.replace(PARENTHETICAL_NOISE, " ");
  s = s.replace(FILENAME_EXTENSIONS, "");
  // "Signature of X" / "X signature" -> "X"
  s = s.replace(/^(signatures?|autographs?)\s+of\s+/i, "");
  s = s.replace(EDGE_NOISE_WORDS, "").trim();
  s = s.replace(EDGE_NOISE_WORDS, "").trim();
  return s;
}

export function normalizeName(raw: string): string {
  let s = stripFilenameBoilerplate(raw);
  s = s.toLowerCase();
  // NFKD + drop combining marks: "Beyoncé" -> "beyonce" (accent-aware, SPEC §15).
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  // Underscores and every dash variant become spaces: "dua-lipa" -> "dua lipa".
  s = s.replace(/[_\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, " ").replace(/-/g, " ");
  // Punctuation (apostrophes, dots, quotes...) is not identity: "D'Angelo" -> "d angelo".
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

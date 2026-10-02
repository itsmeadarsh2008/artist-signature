/**
 * Wikimedia Commons file parser (SPEC §7-10, §54).
 *
 * Pure functions, no network access: `parseCommonsFile` turns one MediaWiki
 * `imageinfo` result (+ optional page wikitext) into a `ParsedCommonsFile`.
 * Tolerates missing fields, HTML values, and malformed wikitext (SPEC §8).
 */

export interface ExtmetadataValue {
  value?: unknown;
  source?: string;
  hidden?: boolean;
}

/** Subset of a MediaWiki `imageinfo` response consumed by the parser. */
export interface CommonsFileInput {
  title: string;
  pageid?: number;
  url?: string;
  descriptionurl?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  sha1?: string;
  timestamp?: string;
  /** `prop=imageinfo` extmetadata map. */
  extmetadata?: Record<string, ExtmetadataValue | undefined>;
  /** Raw page wikitext, when available. */
  wikitext?: string;
  /** Current revision ID, for incremental-update comparisons (SPEC §25). */
  revid?: number;
}

export interface ParsedLicense {
  name: string;
  url?: string;
  usageTerms?: string;
  source: "wikimedia";
  status: "known" | "unknown" | "restricted" | "requires_review";
}

/** SPEC §54 output, plus categories and wikitext for downstream stages. */
export interface ParsedCommonsFile {
  title: string;
  pageId?: number;
  description?: string;
  categories: string[];
  author?: string;
  /** Best-effort person name extracted from description/templates. Never canonical (SPEC §3.2). */
  artist?: string;
  wikidataId?: string;
  license: ParsedLicense;
  sourceUrl?: string;
  originalUrl?: string;
  mime?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  sha1?: string;
  timestamp?: string;
  wikitext?: string;
}

export interface ParsedTemplate {
  name: string;
  params: string[];
  named: Record<string, string>;
}

// ---------------------------------------------------------------------------
// HTML / entity handling (extmetadata values routinely contain HTML)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

/** Coerce an extmetadata value to plain text. Non-strings yield undefined. */
export function extText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const stripped = value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr)>/gi, " ")
    .replace(/<[^>]*>/g, "");
  const text = decodeEntities(stripped).replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

// ---------------------------------------------------------------------------
// Wikitext template parsing (SPEC §9). Extensible: new templates are data,
// handled via LICENSE_TEMPLATES / callers, not new branching here.
// ---------------------------------------------------------------------------

/** Split on top-level `|`, respecting nested `{{...}}` and `[[...]]`. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let linkDepth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const two = inner.slice(i, i + 2);
    if (two === "{{") {
      depth++;
      current += two;
      i++;
    } else if (two === "}}") {
      depth = Math.max(0, depth - 1);
      current += two;
      i++;
    } else if (two === "[[") {
      linkDepth++;
      current += two;
      i++;
    } else if (two === "]]") {
      linkDepth = Math.max(0, linkDepth - 1);
      current += two;
      i++;
    } else if (inner[i] === "|" && depth === 0 && linkDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += inner[i];
    }
  }
  parts.push(current);
  return parts;
}

/** Extract all top-level `{{...}}` templates with balanced-brace scanning. */
export function parseTemplates(wikitext: string): ParsedTemplate[] {
  const out: ParsedTemplate[] = [];
  let i = 0;
  while (i < wikitext.length) {
    const start = wikitext.indexOf("{{", i);
    if (start === -1) break;
    let depth = 0;
    let j = start;
    while (j < wikitext.length) {
      if (wikitext.startsWith("{{", j)) {
        depth++;
        j += 2;
      } else if (wikitext.startsWith("}}", j)) {
        depth--;
        j += 2;
        if (depth === 0) break;
      } else {
        j++;
      }
    }
    if (depth !== 0) break; // unbalanced: stop, don't emit garbage
    const inner = wikitext.slice(start + 2, j - 2);
    const parts = splitTopLevel(inner);
    const name = (parts.shift() ?? "").trim();
    if (name !== "" && !name.startsWith("{")) {
      const named: Record<string, string> = {};
      const params: string[] = [];
      for (const part of parts) {
        const eq = part.indexOf("=");
        // `key=value` only counts as named when the key has no spaces/brackets,
        // otherwise it's positional text that happens to contain "=".
        if (eq > 0 && /^[A-Za-z0-9_ -]+$/.test(part.slice(0, eq).trim())) {
          named[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
        } else {
          params.push(part.trim());
        }
      }
      out.push({ name, params, named });
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function extractCategories(wikitext: string | undefined, extCategories: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const name = raw.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    if (name !== "" && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  if (wikitext) {
    const re = /\[\[\s*[Cc]ategory\s*:\s*([^\]|]+?)\s*(?:\|[^\]]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(wikitext)) !== null) push(m[1]);
  }
  if (extCategories) {
    // extmetadata Categories is typically plain text separated by "|" or newlines.
    for (const chunk of extText(extCategories)?.split(/[|\n]/) ?? []) push(chunk);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wikidata entity (SPEC §13)
// ---------------------------------------------------------------------------

const WIKIDATA_PATTERNS = [
  /wikidata\.org\/wiki\/(Q\d{1,12})\b/i,
  /Special:EntityPage\/(Q\d{1,12})\b/i,
  /\[\[\s*d\s*:\s*(Q\d{1,12})\s*(?:\|[^\]]*)?\]\]/i,
  /\{\{\s*[Oo]n [Ww]ikidata\s*\|\s*(Q\d{1,12})\b/,
  /\|\s*(?:depicts|subject|wikidata|item)\s*=\s*(Q\d{1,12})\b/i,
];

/** Heuristic Q-ID extraction. First signal only; resolver decides trust. */
export function extractWikidataId(wikitext: string | undefined, extValues: string[]): string | undefined {
  const haystacks = [wikitext ?? "", ...extValues];
  for (const hay of haystacks) {
    for (const re of WIKIDATA_PATTERNS) {
      const m = re.exec(hay);
      if (m) return m[1].toUpperCase();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// License extraction (SPEC §10)
// ---------------------------------------------------------------------------

interface LicenseMapping {
  pattern: RegExp;
  name: string;
  url?: string;
  restricted?: boolean;
}

/** Ordered: restricted signals first, then known licenses. Data, not branches. */
const LICENSE_TEMPLATES: LicenseMapping[] = [
  { pattern: /non-?free|fair.?use|copyrighted|permission.?pending|nd\b/i, name: "Restricted", restricted: true },
  { pattern: /^pd-signature/i, name: "PD-signature", url: "https://commons.wikimedia.org/wiki/Template:PD-signature" },
  { pattern: /^pd-(old|art|scan|textlogo|shape|ineligible|us|1923)/i, name: "Public Domain", url: "https://commons.wikimedia.org/wiki/Commons:Public_domain" },
  { pattern: /^cc-?zero|^cc0/i, name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  { pattern: /^cc-by-sa(?:[_-]?(\d(?:\.\d)?))?/i, name: "CC BY-SA", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
  { pattern: /^cc-by(?:[_-]?(\d(?:\.\d)?))?(?![\w-])/i, name: "CC BY", url: "https://creativecommons.org/licenses/by/4.0/" },
  { pattern: /^gfdl/i, name: "GFDL", url: "https://www.gnu.org/licenses/fdl-1.3.html" },
  { pattern: /^self/i, name: "Own work (see template params)", url: undefined },
];

/**
 * Real Commons spellings vary: template params use `cc-by-sa-4.0` while
 * `LicenseShortName` uses `CC BY-SA 4.0`. Normalizing separators first keeps
 * one set of patterns covering both.
 */
const normalizeLicenseId = (value: string): string =>
  value.toLowerCase().replace(/[\s_]+/g, "-");

/** Recognizable grants, e.g. the `cc-by-sa-4.0` inside `{{self|cc-by-sa-4.0}}`. */
const LICENSE_GRANTS: { pattern: RegExp; name: string; url?: string }[] = [
  { pattern: /^cc-zero|^cc0/, name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  { pattern: /^cc-by-sa(?:-(\d(?:\.\d)?))?/, name: "CC BY-SA", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
  { pattern: /^cc-by(?:-(\d(?:\.\d)?))?(?!-sa)/, name: "CC BY", url: "https://creativecommons.org/licenses/by/4.0/" },
  { pattern: /^pd\b|^public-domain/, name: "Public Domain" },
  { pattern: /^gfdl/, name: "GFDL", url: "https://www.gnu.org/licenses/fdl-1.3.html" },
];

const LICENSE_SHORT_NAMES: { pattern: RegExp; name: string; url?: string }[] = [
  { pattern: /^cc0/i, name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  { pattern: /^cc-by-sa/i, name: "CC BY-SA", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
  { pattern: /^cc-by(?!-sa)/i, name: "CC BY", url: "https://creativecommons.org/licenses/by/4.0/" },
  { pattern: /^pd\b|public.?domain/i, name: "Public Domain" },
  { pattern: /^gfdl/i, name: "GFDL", url: "https://www.gnu.org/licenses/fdl-1.3.html" },
  { pattern: /no.?known.?copyright|copyrighted|fair.?use|non-?free/i, name: "Restricted" },
];

export function extractLicense(
  templates: ParsedTemplate[],
  shortName: string | undefined,
  usageTerms: string | undefined,
): ParsedLicense {
  const base: ParsedLicense = { name: "Unknown", source: "wikimedia", status: "unknown" };
  if (usageTerms) base.usageTerms = usageTerms;

  // Restricted wins over everything: never mark a flagged file as free.
  const templateNames = templates.map((t) => t.name);
  for (const t of templateNames) {
    const hit = LICENSE_TEMPLATES.find((m) => m.pattern.test(t));
    if (hit?.restricted) {
      return { ...base, name: hit.name, status: "restricted" };
    }
  }
  if (shortName && LICENSE_SHORT_NAMES.some((m) => m.pattern.test(shortName) && m.name === "Restricted")) {
    return { ...base, name: "Restricted", status: "restricted" };
  }

  for (const t of templateNames) {
    const hit = LICENSE_TEMPLATES.find((m) => m.pattern.test(t) && !m.restricted);
    if (hit && hit.name !== "Own work (see template params)") {
      return { ...base, name: hit.name, url: hit.url, status: "known" };
    }
  }
  // "Own work" templates carry the real grant in their params:
  // {{self|cc-by-sa-4.0}}, {{self|GFDL|cc-by-sa-4.0}}, ...
  for (const t of templates) {
    if (!/^self$/i.test(t.name)) continue;
    for (const param of [...t.params, ...Object.values(t.named)]) {
      const hit = LICENSE_GRANTS.find((m) => m.pattern.test(normalizeLicenseId(param)));
      if (hit) return { ...base, name: hit.name, url: hit.url, status: "known" };
    }
  }
  if (shortName) {
    const normalized = normalizeLicenseId(shortName);
    const hit = LICENSE_SHORT_NAMES.find((m) => m.pattern.test(normalized) && m.name !== "Restricted");
    if (hit) return { ...base, name: hit.name, url: hit.url, status: "known" };
  }
  // "Self" without a concrete grant, or templates present but unrecognized.
  if (templateNames.length > 0) return { ...base, status: "requires_review" };
  return base;
}

// ---------------------------------------------------------------------------
// Person-name hints (inputs to the resolver, never identities themselves)
// ---------------------------------------------------------------------------

const SIGNATURE_OF_RE = /(?:signature|autograph|unterschrift|sign)\s+(?:of|by|from|von)\s+([^,.;|\n\]]+)/i;

export function extractNameFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = SIGNATURE_OF_RE.exec(text);
  if (!m) return undefined;
  const name = m[1].replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return name === "" ? undefined : name;
}

// ---------------------------------------------------------------------------
// Entry point (SPEC §54)
// ---------------------------------------------------------------------------

export function parseCommonsFile(data: CommonsFileInput): ParsedCommonsFile {
  const ext = data.extmetadata ?? {};
  const text = (key: string): string | undefined => {
    const entry = ext[key];
    return entry ? extText(entry.value) : undefined;
  };

  const templates = data.wikitext ? parseTemplates(data.wikitext) : [];
  const description = text("ImageDescription") ?? text("ObjectName");
  const info = templates.find((t) => /^(information|artwork|photograph)$/i.test(t.name));

  const artist =
    extractNameFromText(description) ??
    extractNameFromText(info?.named["description"]) ??
    text("Artist") ??
    text("Author") ??
    text("Credit");

  const extValues = Object.values(ext)
    .map((e) => (typeof e?.value === "string" ? e.value : undefined))
    .filter((v): v is string => v !== undefined);

  return {
    title: data.title,
    pageId: data.pageid,
    description,
    categories: extractCategories(data.wikitext, text("Categories")),
    author: text("Author") ?? text("Artist") ?? text("Credit"),
    artist,
    wikidataId: extractWikidataId(data.wikitext, extValues),
    license: extractLicense(templates, text("LicenseShortName"), text("UsageTerms")),
    sourceUrl: data.descriptionurl,
    originalUrl: data.url,
    mime: data.mime,
    width: data.width,
    height: data.height,
    fileSize: data.size,
    sha1: data.sha1,
    timestamp: data.timestamp,
    wikitext: data.wikitext,
  };
}

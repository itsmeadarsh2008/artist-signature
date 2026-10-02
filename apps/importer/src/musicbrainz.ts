/**
 * MusicBrainz identity lookup (SPEC §14).
 *
 * Canonical artist identity layer. Only exact normalized-name matches are
 * accepted automatically — ambiguous matches are never auto-accepted.
 * In-memory cache + ~1 req/s pacing per MusicBrainz rate-limit policy.
 */

import { normalizeName } from "@artist-signatures/resolver";

const MB_API = "https://musicbrainz.org/ws/2";
const USER_AGENT = "ArtistSignatures/1.0 (dataset importer)";

export interface MusicBrainzArtist {
  id: string;
  name: string;
  sortName?: string;
  type?: string;
  aliases?: string[];
}

let lastCall = 0;
const cache = new Map<string, MusicBrainzArtist | undefined>();

/** Exact normalized match against persons/groups; undefined when ambiguous. */
export async function searchMusicBrainzArtist(name: string, fetchImpl: typeof fetch = fetch): Promise<MusicBrainzArtist | undefined> {
  const key = normalizeName(name);
  if (key === "") return undefined;
  const cached = cache.get(key);
  if (cached !== undefined || cache.has(key)) return cached;

  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const url = `${MB_API}/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=10`;
  const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) {
    cache.set(key, undefined);
    return undefined;
  }
  const data = (await res.json()) as { artists?: { id: string; name: string; "sort-name"?: string; type?: string; aliases?: { name: string }[] }[] };
  const exact = (data.artists ?? []).filter(
    (a) => (a.type === "Person" || a.type === "Group") && normalizeName(a.name) === key,
  );
  // Ambiguous: two different MBIDs with the same normalized name.
  if (exact.length !== 1) {
    cache.set(key, undefined);
    return undefined;
  }
  const found: MusicBrainzArtist = {
    id: exact[0].id,
    name: exact[0].name,
    sortName: exact[0]["sort-name"],
    type: exact[0].type,
    aliases: exact[0].aliases?.map((a) => a.name),
  };
  cache.set(key, found);
  return found;
}

/** Test hook: module-level throttle/cache cannot be reset otherwise. */
export function __resetMusicBrainzCache(): void {
  cache.clear();
  lastCall = 0;
}

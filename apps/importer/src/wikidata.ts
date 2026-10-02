/**
 * Wikidata entity lookup (SPEC §13).
 *
 * Extracts the Q-ID's labels, aliases, and MusicBrainz artist ID (P434).
 * The MusicBrainz ID is preferred whenever available.
 */

const WD_API = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "ArtistSignatures/1.0 (dataset importer)";

export interface WikidataEntity {
  qid: string;
  label?: string;
  aliases: string[];
  /** MusicBrainz artist ID (property P434). */
  musicbrainzId?: string;
}

export async function fetchWikidataEntity(qid: string, fetchImpl: typeof fetch = fetch): Promise<WikidataEntity | undefined> {
  if (!/^Q\d+$/i.test(qid)) return undefined;
  const url = `${WD_API}?${new URLSearchParams({
    action: "wbgetentities",
    ids: qid.toUpperCase(),
    props: "labels|aliases|claims",
    languages: "en",
    languagefallback: "1",
    format: "json",
    formatversion: "2",
  })}`;
  const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return undefined;
  const data = (await res.json()) as {
    entities?: Record<string, { missing?: boolean; labels?: Record<string, { value: string }>; aliases?: Record<string, { value: string }[]>; claims?: Record<string, { mainsnak?: { datavalue?: { value: string } } }[]> }>;
  };
  const entity = data.entities?.[qid.toUpperCase()];
  if (!entity || entity.missing) return undefined;
  const mbClaim = entity.claims?.["P434"]?.[0]?.mainsnak?.datavalue?.value;
  return {
    qid: qid.toUpperCase(),
    label: entity.labels?.["en"]?.value,
    aliases: Object.values(entity.aliases ?? {}).flat().map((a) => a.value),
    musicbrainzId: typeof mbClaim === "string" ? mbClaim : undefined,
  };
}

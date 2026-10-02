import { describe, expect, test } from "bun:test";
import { __resetMusicBrainzCache, searchMusicBrainzArtist } from "./musicbrainz";
import { fetchWikidataEntity } from "./wikidata";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("searchMusicBrainzArtist", () => {
  test("accepts exactly one normalized match", async () => {
    __resetMusicBrainzCache();
    const fetchImpl = (async () =>
      json({ artists: [{ id: "mb-1", name: "Dua Lipa", "sort-name": "Lipa, Dua", type: "Person", aliases: [{ name: "DUA" }] }] })) as unknown as typeof fetch;
    const found = await searchMusicBrainzArtist("dua lipa", fetchImpl);
    expect(found).toMatchObject({ id: "mb-1", name: "Dua Lipa", sortName: "Lipa, Dua" });
  });

  test("rejects ambiguous matches (two MBIDs, same name)", async () => {
    __resetMusicBrainzCache();
    const fetchImpl = (async () =>
      json({ artists: [{ id: "a", name: "Nova", type: "Person" }, { id: "b", name: "Nova", type: "Group" }] })) as unknown as typeof fetch;
    expect(await searchMusicBrainzArtist("Nova", fetchImpl)).toBeUndefined();
  });

  test("caches: second lookup makes no request", async () => {
    __resetMusicBrainzCache();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return json({ artists: [{ id: "mb-2", name: "Cached Act", type: "Group" }] });
    }) as unknown as typeof fetch;
    await searchMusicBrainzArtist("Cached Act", fetchImpl);
    await searchMusicBrainzArtist("cached-act", fetchImpl);
    expect(calls).toBe(1);
  });
});

describe("fetchWikidataEntity", () => {
  test("extracts label, aliases, and P434 MBID", async () => {
    const fetchImpl = (async () =>
      json({
        entities: {
          Q12345: {
            labels: { en: { value: "Dua Lipa" } },
            aliases: { en: [{ value: "Dua" }] },
            claims: { P434: [{ mainsnak: { datavalue: { value: "mb-dua" } } }] },
          },
        },
      })) as unknown as typeof fetch;
    expect(await fetchWikidataEntity("Q12345", fetchImpl)).toEqual({
      qid: "Q12345",
      label: "Dua Lipa",
      aliases: ["Dua"],
      musicbrainzId: "mb-dua",
    });
  });

  test("missing entities and bad QIDs yield undefined", async () => {
    const fetchImpl = (async () => json({ entities: { Q9: { missing: true } } })) as unknown as typeof fetch;
    expect(await fetchWikidataEntity("Q9", fetchImpl)).toBeUndefined();
    expect(await fetchWikidataEntity("not-a-qid", fetchImpl)).toBeUndefined();
  });
});

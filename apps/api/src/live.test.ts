import { describe, expect, test } from "bun:test";
import { createDb, findArtistByNormalized, listSignaturesForArtist, migrateToLatest, type Db } from "@artist-signatures/database";
import { normalizeName } from "@artist-signatures/resolver";
import type { CommonsFileInput } from "@artist-signatures/parser";
import { importLiveSignatures, type LiveLookupDeps } from "./live";

const MIGRATIONS = new URL("../../../migrations", import.meta.url).pathname;

function freshDb(): Db {
  const { db } = createDb(":memory:");
  migrateToLatest(db, MIGRATIONS);
  return db;
}

function duaPage(): CommonsFileInput {
  return {
    title: "File:Dua Lipa (nënshkrim).svg",
    pageid: 91289492,
    revid: 1213860497,
    url: "https://upload.wikimedia.org/wikipedia/commons/1/2/dua.svg",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Dua_Lipa_(n%C3%ABnshkrim).svg",
    mime: "image/svg+xml",
    size: 8912,
    width: 453,
    height: 251,
    extmetadata: {
      ImageDescription: { value: "Digital recreation of Dua Lipa's signature" },
      LicenseShortName: { value: "Public domain" },
      Categories: { value: "Signatures of vocalists from Kosovo" },
    },
    wikitext: "{{PD-signature}}\n[[Category:Signatures of vocalists from Kosovo]]",
  };
}

/** Minimal Commons stub: category listing, text search, metadata batch. */
function stubClient(opts: { searchTitles?: string[]; categoryFiles?: string[] } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async *categoryMembers(title: string, cmtype: string) {
      calls.push(`categorymembers:${title}:${cmtype}`);
      for (const t of opts.categoryFiles ?? []) yield { pageid: 1, title: t, kind: "file" as const };
    },
    async get(params: Record<string, string>) {
      calls.push(`search:${params.srsearch ?? ""}`);
      return { query: { search: (opts.searchTitles ?? []).map((title) => ({ title })) } };
    },
    async fetchFileMetadata(titles: string[]) {
      calls.push(`metadata:${titles.join(",")}`);
      return titles.map((t) => (t === duaPage().title ? duaPage() : undefined)).filter(Boolean) as CommonsFileInput[];
    },
  };
}

const mbStub = async (name: string) =>
  name === "Dua Lipa" ? { id: "mbid-dua", name: "Dua Lipa", sortName: "Lipa, Dua" } : undefined;

/**
 * Real Commons files, grouped by the artist they belong to.
 * Each entry is [title, categories, description].
 */
const REAL_SIGNATURES: Record<string, [string, string, string][]> = {
  "Dua Lipa": [["File:Dua Lipa (nënshkrim).svg", "Signatures of vocalists from Kosovo", "Digital recreation of Dua Lipa's signature"]],
  "Taylor Swift": [
    ["File:Taylor Swift signature.svg", "PD signature:SVG|Signatures of female musicians from the United States", "The signature of singer Taylor Swift"],
    ["File:TaylorSwift Signature.svg", "SVG signatures of musicians", "Firma Taylor Swift"],
    ["File:Taylor Swift signature.jpg", "Signatures of Taylor Swift", "Taylor Swift's signature"],
  ],
  "Ed Sheeran": [
    ["File:Ed Sheeran sig.svg", "Ed Sheeran|PD signature:SVG", "sig of Ed Sheeran"],
    ["File:EdSheeranAssinatura.png", "Ed Sheeran|Self-published work", "Ed Sheeran's official signature."],
  ],
};

/** Real Commons files that merely mention the artist — must never be imported. */
const NON_SIGNATURES: [string, string, string][] = [
  ["File:Taylor Swift Brand Universe.png", "Taylor Swift", "Brand logo"],
  ["File:Taylor Swift - Expomusic 2014.jpg", "Taylor Swift", "Taylor Swift performing at an expo"],
  ["File:Dua Lipa album cover.jpg", "Dua Lipa", "Studio album cover"],
  ["File:Dua Lipa.png", "Dua Lipa", "Dua Lipa, 2021"],
];

/** Builds a stub whose category listing returns exactly the given titles. */
function stubFor(titles: [string, string, string][]): NonNullable<LiveLookupDeps["client"]> {
  const byTitle = new Map(titles.map(([title, cats, desc]) => [title, { cats, desc }]));
  return {
    async *categoryMembers() {
      for (const title of byTitle.keys()) yield { pageid: 1, title, kind: "file" as const };
    },
    async get() {
      return { query: { search: [] } };
    },
    async fetchFileMetadata(requested: string[]) {
      return requested
        .filter((t) => byTitle.has(t))
        .map((title) => {
          const { cats, desc } = byTitle.get(title)!;
          return {
            title,
            pageid: 1,
            url: "https://upload.wikimedia.org/x",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:X",
            mime: "image/svg+xml",
            extmetadata: { ImageDescription: { value: desc } },
            wikitext: `{{PD-signature}}\n` + cats.split("|").map((c) => `[[Category:${c}]]`).join("\n"),
          } satisfies CommonsFileInput;
        });
    },
  } as never;
}

async function importTitles(db: Db, artist: string, cases: [string, string, string][]): Promise<string[]> {
  await importLiveSignatures(db, artist, {
    client: stubFor(cases),
    lookupMusicBrainz: async () => ({ id: `mbid-${artist}`, name: artist }),
  });
  const row = findArtistByNormalized(db, normalizeName(artist));
  if (!row) return [];
  return listSignaturesForArtist(db, row.id, {}, 50).items.map((i) => i.sources[0].sourceTitle!);
}

// Candidate filtering lives in live-filter.test.ts, which pins the real-world
// Commons fixtures (genuine signatures vs. guitar photos, logo sheets, and
// other artists' files). This file covers import mechanics.

describe("importLiveSignatures", () => {
  test("imports a real Commons signature with license + provenance, no download", async () => {
    const db = freshDb();
    const deps: LiveLookupDeps = {
      client: stubClient({ categoryFiles: [duaPage().title] }) as never,
      lookupMusicBrainz: mbStub,
    };
    const imported = await importLiveSignatures(db, "Dua Lipa", deps);
    expect(imported).toBe(1);

    const artist = findArtistByNormalized(db, normalizeName("Dua Lipa"))!;
    expect(artist.musicbrainzId).toBe("mbid-dua");

    const { items } = listSignaturesForArtist(db, artist.id, {}, 10);
    expect(items).toHaveLength(1);
    const sig = items[0].signature;
    // Metadata-only: consumers fetch from the upstream URL themselves.
    expect(sig.assetUrl).toBeNull();
    expect(sig.format).toBe("svg");
    expect(sig.sha256).toBeNull();
    const source = items[0].sources[0];
    expect(source.provider).toBe("wikimedia_commons");
    expect(source.originalUrl).toContain("upload.wikimedia.org");
    expect(source.sourceUrl).toContain("commons.wikimedia.org");
    // The {{PD-signature}} template is authoritative over the short-name field.
    expect(items[0].licenses[0]).toMatchObject({ name: "PD-signature", status: "known" });
  });

  test("is idempotent: a second call imports nothing", async () => {
    const db = freshDb();
    const deps: LiveLookupDeps = { client: stubClient({ categoryFiles: [duaPage().title] }) as never, lookupMusicBrainz: mbStub };
    expect(await importLiveSignatures(db, "Dua Lipa", deps)).toBe(1);
    expect(await importLiveSignatures(db, "Dua Lipa", deps)).toBe(0);
    const artist = findArtistByNormalized(db, normalizeName("Dua Lipa"))!;
    expect(listSignaturesForArtist(db, artist.id, {}, 10).items).toHaveLength(1);
  });

  test("rejects files for other people found by search", async () => {
    const db = freshDb();
    const other: CommonsFileInput = {
      ...duaPage(),
      title: "File:Someone Else signature.svg",
      extmetadata: { ImageDescription: { value: "Signature of Someone Else" }, LicenseShortName: { value: "Public domain" } },
    };
    const deps: LiveLookupDeps = {
      client: {
        async *categoryMembers() {},
        async get() {
          return { query: { search: [{ title: other.title }] } };
        },
        async fetchFileMetadata() {
          return [other];
        },
      } as never,
      lookupMusicBrainz: mbStub,
    };
    expect(await importLiveSignatures(db, "Dua Lipa", deps)).toBe(0);
    expect(findArtistByNormalized(db, normalizeName("Dua Lipa"))).toBeUndefined();
  });

  test("skips restricted-license files", async () => {
    const db = freshDb();
    const nonfree: CommonsFileInput = {
      ...duaPage(),
      title: "File:Dua Lipa signature.jpg",
      mime: "image/jpeg",
      wikitext: "{{Non-free logo}}",
    };
    const deps: LiveLookupDeps = {
      client: {
        async *categoryMembers() {},
        async get() {
          return { query: { search: [{ title: nonfree.title }] } };
        },
        async fetchFileMetadata() {
          return [nonfree];
        },
      } as never,
      lookupMusicBrainz: mbStub,
    };
    expect(await importLiveSignatures(db, "Dua Lipa", deps)).toBe(0);
  });

  test("creates a name-only artist when MusicBrainz has no exact match", async () => {
    const db = freshDb();
    const deps: LiveLookupDeps = {
      client: stubClient({ categoryFiles: [duaPage().title] }) as never,
      lookupMusicBrainz: async () => undefined,
    };
    expect(await importLiveSignatures(db, "Dua Lipa", deps)).toBe(1);
    const artist = findArtistByNormalized(db, normalizeName("Dua Lipa"))!;
    expect(artist.musicbrainzId).toBeNull();
    expect(listSignaturesForArtist(db, artist.id, {}, 10).items[0].resolutions).toHaveLength(0);
  });

  test("empty name and empty upstream are no-ops", async () => {
    const db = freshDb();
    expect(await importLiveSignatures(db, "  ", {})).toBe(0);
    const empty: LiveLookupDeps = {
      client: { async *categoryMembers() {}, async get() { return { query: { search: [] } }; }, async fetchFileMetadata() { return []; } } as never,
    };
    expect(await importLiveSignatures(db, "Nobody Here", empty)).toBe(0);
  });
});
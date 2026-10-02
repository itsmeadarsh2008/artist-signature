import { describe, expect, test } from "bun:test";
import { normalizeName } from "@artist-signatures/resolver";
import { parseCommonsFile, type CommonsFileInput } from "@artist-signatures/parser";
import { importLiveSignatures, type LiveLookupDeps } from "./live";
import { createDb, migrateToLatest, findArtistByNormalized, listSignaturesForArtist, type Db } from "@artist-signatures/database";

const MIGRATIONS = new URL("../../../migrations", import.meta.url).pathname;

function freshDb(): Db {
  const { db } = createDb(":memory:");
  migrateToLatest(db, MIGRATIONS);
  return db;
}

/** Builds a Commons page fixture from real extmetadata/wikitext shapes. */
function page(title: string, description: string, categories: string[], mime = "image/svg+xml"): CommonsFileInput {
  return {
    title,
    pageid: 1,
    url: "https://upload.wikimedia.org/x",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:X",
    mime,
    extmetadata: { ImageDescription: { value: description }, LicenseShortName: { value: "Public domain" } },
    wikitext: `{{PD-signature}}\n${categories.map((c) => `[[Category:${c}]]`).join("\n")}`,
  };
}

function stubFor(pages: CommonsFileInput[]): NonNullable<LiveLookupDeps["client"]> {
  const byTitle = new Map(pages.map((p) => [p.title, p]));
  return {
    async *categoryMembers() {
      for (const p of pages) yield { pageid: 1, title: p.title, kind: "file" as const };
    },
    async get() {
      return { query: { search: [] } };
    },
    async fetchFileMetadata(requested: string[]) {
      return requested.map((t) => byTitle.get(t)).filter((p): p is CommonsFileInput => Boolean(p));
    },
  } as never;
}

async function importTitles(db: Db, artist: string, pages: CommonsFileInput[]): Promise<string[]> {
  await importLiveSignatures(db, artist, {
    client: stubFor(pages),
    lookupMusicBrainz: async () => ({ id: `mbid-${artist}`, name: artist }),
  });
  const row = findArtistByNormalized(db, normalizeName(artist));
  if (!row) return [];
  return listSignaturesForArtist(db, row.id, {}, 50).items.map((i) => i.sources[0].sourceTitle!);
}

// ---------------------------------------------------------------------------
// Fixtures captured from the live Wikimedia Commons API.
// ---------------------------------------------------------------------------

const GENUINE_SIGNATURES: Record<string, CommonsFileInput[]> = {
  "Dua Lipa": [page("File:Dua Lipa (nënshkrim).svg", "Digital recreation of Dua Lipa's signature", ["PD signature:SVG", "Signatures of vocalists from Kosovo"])],
  "Taylor Swift": [
    page("File:Taylor Swift signature.svg", "The signature of singer Taylor Swift", ["PD signature:SVG", "Signatures of female musicians from the United States"]),
    page("File:TaylorSwift Signature.svg", "Firma Taylor Swift", ["SVG signatures of musicians"]),
    page("File:Taylor Swift signature.jpg", "Taylor Swift's signature", ["Signatures of Taylor Swift"], "image/jpeg"),
  ],
  "Ed Sheeran": [
    page("File:Ed Sheeran sig.svg", "sig of Ed Sheeran", ["Ed Sheeran", "PD signature:SVG"]),
    page("File:EdSheeranAssinatura.png", "Ed Sheeran's official signature.", ["Ed Sheeran", "Self-published work"], "image/png"),
  ],
};

/**
 * Real Commons files that a naive name match would wrongly accept.
 * Each has the artist's name plus signature-ish wording that is NOT about the
 * person signing anything.
 */
const FALSE_POSITIVES: [string, string, string[]][] = [
  // A photo of a GUITAR; "Signature" is a product line, and the file is filed
  // under Signature/Taylor Guitars categories.
  [
    "File:Taylor Swift Baby Taylor (center), Taylor Baby Taylor series (sides), & GS Mini (bottom) - Expomusic 2014 - edit.jpg",
    "Taylor Swift Baby Taylor (center), Taylor Baby Taylor series (sides), & GS Mini (bottom) - Expomusic 2014",
    ["Taylor Swift Baby Taylor", "Taylor Guitars", "Signature guitar models", "Taylor GS Mini", "Parlor guitars"],
  ],
  // A logo sheet whose description mentions the artist's signature.
  ["File:Taylor Swift Brand Universe.png", "Taylor Swift's branded universe. The center of the visual has been changed to include TS signature, to replace a photo of TS in the original", ["Taylor Swift logos", "Graphics created by WIPO"]],
  // Another artist's signature: must never leak into this artist.
  ["File:Ariana Grande signature.svg", "Signature of Ariana Grande", ["Signatures of Ariana Grande"]],
];

describe("importLiveSignatures candidate filtering", () => {
  test("keeps genuine signature files", async () => {
    for (const [artist, pages] of Object.entries(GENUINE_SIGNATURES)) {
      const db = freshDb();
      const kept = await importTitles(db, artist, pages);
      expect({ artist, kept: kept.sort() }).toEqual({
        artist,
        kept: pages.map((p) => p.title).sort(),
      });
    }
  });

  test("rejects real-world false positives", async () => {
    for (const [title, description, categories] of FALSE_POSITIVES) {
      const db = freshDb();
      const mime = title.endsWith(".jpg") ? "image/jpeg" : "image/png";
      const kept = await importTitles(db, "Taylor Swift", [page(title, description, categories, mime)]);
      expect({ title, kept }).toEqual({ title, kept: [] });
    }
  });

  test("does not leak one artist's file into another's record", async () => {
    const db = freshDb();
    const mixed = [...GENUINE_SIGNATURES["Taylor Swift"], ...GENUINE_SIGNATURES["Dua Lipa"]];
    const kept = await importTitles(db, "Taylor Swift", mixed);
    expect(kept).not.toContain("File:Dua Lipa (nënshkrim).svg");
    expect(kept).toHaveLength(3);
  });

  test("parser output sanity: signature words survive normalization", () => {
    // Guards the trap this feature hit: normalizeName strips "signature" from
    // categories and "(nënshkrim)" from titles, so hints must read raw text.
    const parsed = parseCommonsFile(GENUINE_SIGNATURES["Dua Lipa"][0]);
    expect(parsed.categories[1]).toBe("Signatures of vocalists from Kosovo");
    expect(normalizeName(parsed.categories[1])).not.toContain("signature");
    expect(normalizeName(parsed.title)).toBe("dua lipa");
  });
});
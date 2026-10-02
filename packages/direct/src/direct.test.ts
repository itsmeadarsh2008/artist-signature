import { describe, expect, test } from "bun:test";
import { findLiveRecords, type DirectDeps } from "./index";
import type { CommonsFileInput } from "@artist-signatures/parser";

function duaPage(): CommonsFileInput {
  return {
    title: "File:Dua Lipa (nënshkrim).svg",
    pageid: 91289492,
    revid: 1213860497,
    url: "https://upload.wikimedia.org/wikipedia/commons/1/2/dua.svg",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Dua_Lipa.svg",
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

function stubClient(pages: CommonsFileInput[] = [duaPage()]) {
  return {
    async *categoryMembers() {
      for (const p of pages) yield { pageid: p.pageid ?? 1, title: p.title, kind: "file" as const };
    },
    async get() {
      return { query: { search: [] } };
    },
    async fetchFileMetadata() {
      return pages;
    },
  };
}

const mbStub = async (name: string) =>
  name === "Dua Lipa" ? { id: "mbid-dua", name: "Dua Lipa" } : undefined;

describe("findLiveRecords (no database)", () => {
  test("returns API-shaped records for a genuine signature", async () => {
    const { artist, items } = await findLiveRecords("Dua Lipa", {
      client: stubClient() as never,
      lookupMusicBrainz: mbStub,
    } satisfies DirectDeps);
    expect(artist).toEqual({ name: "Dua Lipa", musicbrainzId: "mbid-dua" });
    expect(items).toHaveLength(1);
    expect(items[0].record).toMatchObject({
      id: "live-91289492",
      artist: { name: "Dua Lipa", musicbrainz_id: "mbid-dua" },
      asset: { url: "https://upload.wikimedia.org/wikipedia/commons/1/2/dua.svg", format: "svg" },
      source: { provider: "wikimedia_commons" },
      license: { name: "PD-signature" },
      verification: "unverified",
    });
    // The parsed file travels alongside for consumers that persist it.
    expect(items[0].parsed.title).toBe("File:Dua Lipa (nënshkrim).svg");
  });

  test("empty for unknown names and blank queries, without touching MusicBrainz", async () => {
    let mbCalls = 0;
    const deps: DirectDeps = {
      client: stubClient([]) as never,
      lookupMusicBrainz: async () => {
        mbCalls++;
        return undefined;
      },
    };
    expect((await findLiveRecords("Nobody Here", deps)).items).toEqual([]);
    expect((await findLiveRecords("  ", deps)).items).toEqual([]);
    expect(mbCalls).toBe(0);
  });
});


describe("pickBest()", () => {
  const rec = (id: string, format: string, status: string | null, verification: string) => ({
    id,
    asset: { url: "https://cdn.example.com/x", format, type: "handwritten" },
    source: { provider: "wikimedia_commons", url: "https://commons.wikimedia.org/wiki/File:X", original_url: null },
    license: { name: "L", status },
    verification,
  });

  test("badges the ranked winner by id, null when empty", async () => {
    const { pickBest } = await import("./index");
    expect(pickBest([rec("a", "jpeg", "unknown", "unverified"), rec("b", "svg", "known", "unverified")])).toBe("b");
    expect(pickBest([rec("a", "svg", "known", "verified"), rec("b", "svg", "known", "unverified")])).toBe("a");
    expect(pickBest([])).toBeNull();
  });
});

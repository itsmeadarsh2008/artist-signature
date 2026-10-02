import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, insertSignatureFull, migrateToLatest, upsertArtist } from "@artist-signatures/database";
import { normalizeName } from "@artist-signatures/resolver";
import { ArtistSignatures, ArtistSignaturesError } from "./index";
import { createApp } from "../../../apps/api/src/index";

const MIGRATIONS = new URL("../../../migrations", import.meta.url).pathname;

function stubFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const route = routes[u.pathname] ?? routes[`${u.pathname}?${u.searchParams.toString()}`];
    if (!route) return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "no stub" } }), { status: 500 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as unknown as typeof fetch;
}

describe("remote mode", () => {
  test("search passes params and returns results", async () => {
    const api = new ArtistSignatures({
      baseUrl: "http://api.example.com",
      fetchImpl: stubFetch({ "/v1/search": { status: 200, body: { results: [{ type: "artist", name: "Dua Lipa" }] } } }),
    });
    const res = await api.search("dua", { limit: 5 });
    expect(res.results[0].name).toBe("Dua Lipa");
  });

  test("API errors map to coded errors", async () => {
    const api = new ArtistSignatures({
      baseUrl: "http://api.example.com",
      fetchImpl: stubFetch({ "/v1/signatures": { status: 404, body: { error: { code: "ARTIST_NOT_FOUND", message: "No artist." } } } }),
    });
    const err = await api.signatures("Nobody").catch((e) => e);
    expect(err).toBeInstanceOf(ArtistSignaturesError);
    expect((err as ArtistSignaturesError).code).toBe("ARTIST_NOT_FOUND");
  });

  test("getSignature returns the first usable signature", async () => {
    const api = new ArtistSignatures({
      baseUrl: "http://api.example.com",
      fetchImpl: stubFetch({
        "/v1/signatures": { status: 200, body: { artist: { name: "X" }, signatures: [{ asset: { url: "https://cdn/x.svg" } }] } },
      }),
    });
    expect((await api.getSignature("X")).asset.url).toBe("https://cdn/x.svg");
  });
});

describe("dataset mode", () => {
  async function datasetDb() {
    const dir = await mkdtemp(join(tmpdir(), "client-ds-"));
    const path = join(dir, "snap.sqlite");
    const { db } = createDb(path);
    migrateToLatest(db, MIGRATIONS);
    const artist = upsertArtist(db, { name: "Dua Lipa", musicbrainzId: "mbid-dua" }, normalizeName);
    insertSignatureFull(db, {
      artistId: artist.id,
      format: "svg",
      sha256: "ds1",
      assetUrl: "signatures/ds/ds/ds1.svg",
      source: { provider: "wikimedia_commons", sourceTitle: "File:A.svg", originalUrl: "https://upload.wikimedia.org/a.svg" },
      license: { name: "CC0 1.0", status: "known" },
      resolution: { method: "musicbrainz_name_match", confidence: 0.95 },
    });
    return path;
  }

  test("answers the same queries offline, exposing mirror paths", async () => {
    const api = await ArtistSignatures.fromDataset(await datasetDb());
    const res = (await api.signatures("Dua Lipa")) as { artist: { name: string }; signatures: { asset: { url?: string; path?: string } }[] };
    expect(res.artist.name).toBe("Dua Lipa");
    expect(res.signatures).toHaveLength(1);
    expect(res.signatures[0].asset.url).toBe("https://upload.wikimedia.org/a.svg");
    expect(res.signatures[0].asset.path).toBe("signatures/ds/ds/ds1.svg");
    const search = await api.search("dua");
    expect(search.results[0].name).toBe("Dua Lipa");
    const byMbid = (await api.artistByMusicBrainzId("mbid-dua")) as { name: string };
    expect(byMbid.name).toBe("Dua Lipa");
    await expect(api.signatures("Madonna")).rejects.toMatchObject({ code: "ARTIST_NOT_FOUND" });
  });
});

describe("live roundtrip (client -> HTTP -> API -> db)", () => {
  test("end to end over a real socket", async () => {
    const { db } = createDb(":memory:");
    migrateToLatest(db, MIGRATIONS);
    const assetDir = await mkdtemp(join(tmpdir(), "client-live-"));
    const artist = upsertArtist(db, { name: "Dua Lipa", musicbrainzId: "mbid-dua" }, normalizeName);
    insertSignatureFull(db, {
      artistId: artist.id,
      format: "svg",
      sha256: "live1",
      source: { provider: "wikimedia_commons", sourceTitle: "File:Live.svg", originalUrl: "https://upload.wikimedia.org/live.svg" },
      license: { name: "PD-signature", status: "known" },
      resolution: { method: "musicbrainz_name_match", confidence: 0.95 },
    });
    const app = createApp({ db, assetDir, publicBaseUrl: "http://cdn.example.com" });
    app.listen(0);
    try {
      const port = (app.server as { port: number } | null)?.port;
      expect(port).toBeGreaterThan(0);
      const api = new ArtistSignatures({ baseUrl: `http://localhost:${port}` });
      const sig = (await api.getSignature("Dua Lipa")) as { asset: { url: string } };
      expect(sig.asset.url).toBe("https://upload.wikimedia.org/live.svg");
    } finally {
      app.stop();
    }
  });
});

describe("ArtistSignatures.direct()", () => {
  const duaPage = {
    title: "File:Dua Lipa (nënshkrim).svg",
    pageid: 91289492,
    url: "https://upload.wikimedia.org/wikipedia/commons/1/2/dua.svg",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Dua_Lipa.svg",
    mime: "image/svg+xml",
    extmetadata: {
      ImageDescription: { value: "Digital recreation of Dua Lipa's signature" },
      LicenseShortName: { value: "Public domain" },
    },
    wikitext: "{{PD-signature}}\n[[Category:Signatures of vocalists from Kosovo]]",
  };
  const stub = {
    async *categoryMembers() {
      yield { pageid: 91289492, title: duaPage.title, kind: "file" as const };
    },
    async get() {
      return { query: { search: [] } };
    },
    async fetchFileMetadata() {
      return [duaPage];
    },
  };
  const mb = async (name: string) => (name === "Dua Lipa" ? { id: "mbid-dua", name: "Dua Lipa" } : undefined);
  const direct = () => ArtistSignatures.direct({ client: stub as never, lookupMusicBrainz: mb });

  test("signatures() answers without a server or database", async () => {
    const res = (await direct().signatures("Dua Lipa")) as { artist: { name: string }; signatures: { id: string }[] };
    expect(res.artist.name).toBe("Dua Lipa");
    expect(res.signatures.map((s) => s.id)).toEqual(["live-91289492"]);
  });

  test("getSignature() returns the first usable record", async () => {
    const sig = (await direct().getSignature("Dua Lipa")) as { asset: { url: string } };
    expect(sig.asset.url).toContain("upload.wikimedia.org");
  });

  test("unknown names raise ARTIST_NOT_FOUND; search raises INVALID_REQUEST", async () => {
    await expect(direct().signatures("Nobody Here")).rejects.toMatchObject({ code: "ARTIST_NOT_FOUND" });
    await expect(direct().search("dua")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("format filter applies client-side", async () => {
    await expect(direct().signatures("Dua Lipa", { format: "png" })).rejects.toMatchObject({ code: "SIGNATURE_NOT_FOUND" });
  });
});

describe("ArtistSignatures.best()", () => {
  // Canned order is deliberately worst-first: best() must rank, not take [0].
  const worst = {
    id: "sig_first",
    asset: { url: "https://cdn.example.com/first.jpg", format: "jpeg", type: "unknown" },
    source: { provider: "wikimedia_commons", url: "https://commons.wikimedia.org/wiki/File:F", original_url: "https://cdn.example.com/first.jpg" },
    license: { name: "Unknown", status: "unknown" },
    verification: "unverified",
  };
  const best = {
    id: "sig_best",
    asset: { url: "https://cdn.example.com/best.svg", format: "svg", type: "handwritten" },
    source: { provider: "wikimedia_commons", url: "https://commons.wikimedia.org/wiki/File:B", original_url: "https://cdn.example.com/best.svg" },
    license: { name: "CC0 1.0", status: "known" },
    verification: "verified",
  };
  const stubFetch = (async () =>
    new Response(JSON.stringify({ artist: { name: "Dua Lipa" }, signatures: [worst, best] }), { status: 200 })) as unknown as typeof fetch;

  test("best() ranks by license/format/verification, not position", async () => {
    const api = new ArtistSignatures({ baseUrl: "http://api.example.com", fetchImpl: stubFetch });
    const top = (await api.best("Dua Lipa")) as { id: string };
    expect(top.id).toBe("sig_best");
    // …while getSignature() keeps first-usable semantics.
    const first = (await api.getSignature("Dua Lipa")) as unknown as { id: string };
    expect(first.id).toBe("sig_first");
  });

  test("best() raises SIGNATURE_NOT_FOUND on empty or unservable lists", async () => {
    const emptyFetch = (async () =>
      new Response(JSON.stringify({ artist: { name: "Dua Lipa" }, signatures: [] }), { status: 200 })) as unknown as typeof fetch;
    const api = new ArtistSignatures({ baseUrl: "http://api.example.com", fetchImpl: emptyFetch });
    await expect(api.best("Dua Lipa")).rejects.toMatchObject({ code: "SIGNATURE_NOT_FOUND" });
  });
});

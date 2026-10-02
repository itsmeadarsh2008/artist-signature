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

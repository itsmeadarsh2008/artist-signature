import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  insertSignatureFull,
  migrateToLatest,
  upsertArtist,
  type Db,
} from "@artist-signatures/database";
import { normalizeName } from "@artist-signatures/resolver";
import type { CommonsFileInput } from "@artist-signatures/parser";
import { createApp } from "./index";

const MIGRATIONS = new URL("../../../migrations", import.meta.url).pathname;

async function seed(): Promise<{ db: Db; assetDir: string; sigSvg: string; sigPng: string; artistId: string }> {
  const { db } = createDb(":memory:");
  migrateToLatest(db, MIGRATIONS);
  const assetDir = await mkdtemp(join(tmpdir(), "api-assets-"));
  const artist = upsertArtist(db, { name: "Ada Melody", musicbrainzId: "mbid-ada", wikidataId: "Q999001", aliases: ["Ada M."] }, normalizeName);
  const src = (title: string) => ({
    provider: "wikimedia_commons",
    sourceTitle: title,
    sourceUrl: "https://commons.wikimedia.org/wiki/File:X",
    originalUrl: "https://upload.wikimedia.org/x",
  });
  const lic = { name: "PD-signature", url: "https://commons.wikimedia.org/wiki/Template:PD-signature", status: "known" };
  const svg = insertSignatureFull(db, {
    artistId: artist.id, type: "handwritten", format: "svg", sha256: "s1",
    assetUrl: "signatures/s1/s1/s1.svg", source: src("File:A.svg"), license: lic,
    resolution: { method: "wikidata_musicbrainz", confidence: 1, matchedArtistId: artist.id },
  });
  insertSignatureFull(db, {
    artistId: artist.id, type: "autograph", format: "png", sha256: "s2",
    source: src("File:B.png"), license: lic,
    resolution: { method: "musicbrainz_name_match", confidence: 0.95, matchedArtistId: artist.id },
  });
  await mkdir(join(assetDir, "signatures/s1/s1"), { recursive: true });
  await writeFile(join(assetDir, "signatures/s1/s1/s1.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  return { db, assetDir, sigSvg: svg.signatureId, sigPng: "", artistId: artist.id };
}

async function seedPngId(db: Db): Promise<string> {
  const { sql } = await import("drizzle-orm");
  return db.all<{ id: string }>(sql`SELECT id FROM signatures WHERE format = 'png';`)[0].id;
}

async function get(app: { handle: (req: Request) => Promise<Response> }, path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("live lookup", () => {
  // Each test gets its own DB: live imports persist by design, so a shared
  // fixture would leak records across cases.
  async function liveSeed() {
    return seed();
  }
  const dua: CommonsFileInput = {
    title: "File:Dua Lipa (nënshkrim).svg",
    pageid: 91289492,
    revid: 1,
    url: "https://upload.wikimedia.org/wikipedia/commons/1/2/dua.svg",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Dua_Lipa.svg",
    mime: "image/svg+xml",
    extmetadata: { ImageDescription: { value: "Digital recreation of Dua Lipa's signature" }, LicenseShortName: { value: "Public domain" } },
    wikitext: "{{PD-signature}}\n[[Category:Signatures of vocalists from Kosovo]]",
  };

  function liveStub() {
    return {
      async *categoryMembers() {
        yield { pageid: 1, title: dua.title, kind: "file" as const };
      },
      async get() {
        return { query: { search: [] } };
      },
      async fetchFileMetadata() {
        return [dua];
      },
    };
  }

  test("uncrawled name resolves live instead of 404", async () => {
    const { db, assetDir } = await seed();
    const app = createApp({
      db,
      assetDir,
      publicBaseUrl: "http://cdn.example.com",
      live: { client: liveStub() as never, lookupMusicBrainz: async () => ({ id: "mbid-dua", name: "Dua Lipa" }) },
    });
    const { status, body } = await get(app, "/v1/signatures?artist=Dua%20Lipa");
    expect(status).toBe(200);
    const b = body as { artist: { musicbrainz_id: string }; signatures: { asset: { url?: string }; license: { name: string } }[] };
    expect(b.artist.musicbrainz_id).toBe("mbid-dua");
    expect(b.signatures).toHaveLength(1);
    // No mirror downloaded: the upstream original is served (SPEC §49).
    expect(b.signatures[0].asset.url).toContain("upload.wikimedia.org");
    expect(b.signatures[0].license.name).toBe("PD-signature");
  });

  test("live is off by default, so uncrawled names still 404", async () => {
    const { db, assetDir } = await seed();
    const app = createApp({ db, assetDir, publicBaseUrl: "http://cdn.example.com" });
    expect((await get(app, "/v1/signatures?artist=Dua%20Lipa")).status).toBe(404);
  });

  test("upstream failures degrade to 404, never a 500", async () => {
    const { db, assetDir } = await seed();
    const app = createApp({
      db,
      assetDir,
      publicBaseUrl: "http://cdn.example.com",
      live: {
        client: {
          async *categoryMembers() {
            throw new Error("commons down");
          },
          async get() {
            throw new Error("commons down");
          },
          async fetchFileMetadata() {
            throw new Error("commons down");
          },
        } as never,
      },
    });
    const res = await get(app, "/v1/signatures?artist=Someone Unheard Of");
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe("ARTIST_NOT_FOUND");
  });
});

describe("read endpoints", () => {
  test("name lookup returns artist + signatures with provenance", async () => {
    const { db, assetDir } = await seed();
    const app = createApp({ db, assetDir, publicBaseUrl: "http://cdn.example.com" });
    const { status, body } = await get(app, "/v1/signatures?artist=Ada%20Melody");
    expect(status).toBe(200);
    const b = body as { artist: { name: string; musicbrainz_id: string }; signatures: { id: string; asset: { url: string; format: string }; license: { name: string }; source: { provider: string } }[] };
    expect(b.artist).toMatchObject({ name: "Ada Melody", musicbrainz_id: "mbid-ada" });
    expect(b.signatures).toHaveLength(2);
    // Both rows can share a created_at millisecond, so match by format rather
    // than by position: ordering falls back to a random id.
    const mirrored = b.signatures.find((s) => s.asset.format === "svg")!;
    const upstreamOnly = b.signatures.find((s) => s.asset.format === "png")!;
    expect(mirrored.asset.url).toContain("http://cdn.example.com/v1/assets/");
    expect(mirrored.license.name).toBe("PD-signature");
    expect(mirrored.source.provider).toBe("wikimedia_commons");
    // Unmirrored assets fall back to the upstream original (SPEC §49).
    expect(upstreamOnly.asset.url).toBe("https://upload.wikimedia.org/x");
  });

  test("filtering, pagination, and validation", async () => {
    const { db, assetDir } = await seed();
    const app = createApp({ db, assetDir, publicBaseUrl: "http://cdn.example.com" });
    expect(((await get(app, "/v1/signatures?artist=Ada%20Melody&format=png")).body as { signatures: unknown[] }).signatures).toHaveLength(1);
    expect((await get(app, "/v1/signatures?artist=Ada%20Melody&format=bogus")).status).toBe(400);
    const bad = await get(app, "/v1/signatures?artist=Ada%20Melody&format=bogus");
    expect((bad.body as { error: { code: string } }).error.code).toBe("INVALID_FORMAT");
    expect((await get(app, "/v1/signatures")).status).toBe(400);
    expect((await get(app, "/v1/signatures?artist=Nobody At All")).status).toBe(404);
    const near = (await get(app, "/v1/signatures?artist=Ad")).body as { matches: { name: string }[] };
    expect(near.matches[0].name).toBe("Ada Melody");
    const p1 = (await get(app, "/v1/signatures?artist=Ada%20Melody&limit=1")).body as { signatures: unknown[]; nextCursor: string };
    expect(p1.signatures).toHaveLength(1);
    expect(typeof p1.nextCursor).toBe("string");
    const p2 = (await get(app, `/v1/signatures?artist=Ada%20Melody&limit=1&cursor=${encodeURIComponent(p1.nextCursor)}`)).body as { signatures: unknown[]; nextCursor?: string };
    expect(p2.signatures).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
    expect((await get(app, "/v1/signatures?artist=Ada%20Melody&limit=0")).status).toBe(400);
  });

  test("/v1/name/:name, /v1/artists/:mbid, single signature, search", async () => {
    const { db, assetDir, sigSvg } = await seed();
    const app = createApp({ db, assetDir, publicBaseUrl: "http://cdn.example.com" });
    const byName = (await get(app, "/v1/name/Ada%20Melody")).body as { signatures: unknown[] };
    expect(byName.signatures).toHaveLength(2);
    const byMbid = (await get(app, "/v1/artists/mbid-ada")).body as { aliases: string[]; signatures: unknown[] };
    expect(byMbid.aliases).toContain("Ada M.");
    expect(byMbid.signatures).toHaveLength(2);
    expect((await get(app, "/v1/artists/nope")).status).toBe(404);
    const one = (await get(app, `/v1/signatures/${sigSvg}`)).body as { id: string; verification: string };
    expect(one.id).toBe(sigSvg);
    expect(one.verification).toBe("unverified");
    expect((await get(app, "/v1/signatures/sig_nope")).status).toBe(404);
    const search = (await get(app, "/v1/search?q=ada")).body as { results: { type: string; signature_count: number }[] };
    expect(search.results[0]).toMatchObject({ type: "artist", signature_count: 2 });
    expect((await get(app, "/v1/search")).status).toBe(400);
  });

  test("mirrored assets are served with immutable caching", async () => {
    const { db, assetDir } = await seed();
    const app = createApp({ db, assetDir, publicBaseUrl: "http://cdn.example.com" });
    const res = await app.handle(new Request("http://localhost/v1/assets/signatures/s1/s1/s1.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toContain("<svg");
    expect((await get(app, "/v1/assets/../secret")).status).toBe(404);
    expect((await get(app, "/v1/assets/signatures/nope.svg")).status).toBe(404);
  });
});

describe("takedowns and moderation", () => {
  test("takedown disables serving; admin can restore", async () => {
    const { db, assetDir } = await seed();
    const sigPng = await seedPngId(db);
    const app = createApp({ db, assetDir, publicBaseUrl: "http://cdn.example.com" });
    const created = await app.handle(
      new Request("http://localhost/v1/takedowns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signatureId: sigPng, reason: "artist request", requester: "label@example.com" }),
      }),
    );
    expect(created.status).toBe(201);
    const listed = (await get(app, "/v1/signatures?artist=Ada%20Melody")).body as { signatures: unknown[] };
    expect(listed.signatures).toHaveLength(1);
    const badBody = await app.handle(new Request("http://localhost/v1/takedowns", { method: "POST", body: "{}" }));
    expect(badBody.status).toBe(400);
    const restore = await app.handle(
      new Request(`http://localhost/admin/signatures/${sigPng}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "available", action: "restore", actor: "mod-1" }),
      }),
    );
    expect(restore.status).toBe(200);
    const relisted = (await get(app, "/v1/signatures?artist=Ada%20Melody")).body as { signatures: unknown[] };
    expect(relisted.signatures).toHaveLength(2);
  });

  test("review queue lists pending resolutions; approve clears them", async () => {
    const { db, assetDir } = await seed();
    const app = createApp({ db, assetDir, publicBaseUrl: "http://cdn.example.com" });
    const queue = (await get(app, "/admin/review/unresolved")).body as { resolutions: { resolution: { id: string } }[] };
    expect(queue.resolutions.length).toBeGreaterThan(0);
    const approve = await app.handle(new Request(`http://localhost/admin/review/${queue.resolutions[0].resolution.id}/approve`, { method: "POST" }));
    expect(approve.status).toBe(200);
    const empty = (await get(app, "/admin/review/unresolved")).body as { resolutions: unknown[] };
    expect(empty.resolutions.length).toBe(queue.resolutions.length - 1);
    const missing = await app.handle(new Request("http://localhost/admin/review/res_nope/approve", { method: "POST" }));
    expect(missing.status).toBe(404);
  });
});

describe("rate limiting", () => {
  test("trips after the configured per-minute budget", async () => {
    const { db, assetDir } = await seed();
    const app = createApp({ db, assetDir, publicBaseUrl: "http://cdn.example.com", rateLimitPerMinute: 2 });
    expect((await get(app, "/v1/health")).status).toBe(200);
    expect((await get(app, "/v1/health")).status).toBe(200);
    const limited = await get(app, "/v1/health");
    expect(limited.status).toBe(429);
    expect((limited.body as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });
});

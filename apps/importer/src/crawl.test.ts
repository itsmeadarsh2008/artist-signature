import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, migrateToLatest } from "@artist-signatures/database";
import type { CommonsFileInput } from "@artist-signatures/parser";
import { runCrawl } from "./crawl";
import type { PipelineDeps } from "./pipeline";
import type { CategoryMember, CommonsClient } from "./wikimedia";

const MIGRATIONS = new URL("../../../migrations", import.meta.url).pathname;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TREE: Record<string, CategoryMember[]> = {
  "Category:Root": [
    { pageid: 1, title: "Category:Child", kind: "subcat" },
    { pageid: 2, title: "File:A.svg", kind: "file" },
  ],
  "Category:Child": [{ pageid: 3, title: "File:B.svg", kind: "file" }],
};

function fileMeta(title: string): CommonsFileInput {
  return {
    title,
    pageid: title.length,
    url: "https://upload.wikimedia.org/x",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:X",
    mime: "image/png",
    extmetadata: { ImageDescription: { value: "Signature of Crawl Artist" }, LicenseShortName: { value: "CC0" } },
    wikitext: "{{Cc-zero}}",
  };
}

async function testDeps(): Promise<PipelineDeps> {
  const client = {
    async *categoryMembers(title: string) {
      yield* TREE[title] ?? [];
    },
    async fetchFileMetadata(titles: string[]) {
      return titles.map(fileMeta);
    },
  } as unknown as CommonsClient;
  return {
    client,
    assetDir: await mkdtemp(join(tmpdir(), "crawl-assets-")),
    downloadBytes: async () => ({ bytes: PNG, contentType: "image/png" }),
    lookupMusicBrainz: async () => ({ id: "mb-crawl", name: "Crawl Artist" }),
    fetchWikidata: async () => undefined,
  };
}

describe("runCrawl", () => {
  test("discovers recursively and imports; second run is a no-op", async () => {
    const { db } = createDb(":memory:");
    migrateToLatest(db, MIGRATIONS);
    const first = await runCrawl(db, await testDeps(), { roots: ["Category:Root"], maxDepth: 1, maxFiles: 10 });
    expect(first.categories).toBe(2);
    expect(first.filesDiscovered).toBe(2);
    expect(first.imported).toBe(2);
    expect(first.failed).toBe(0);

    const second = await runCrawl(db, await testDeps(), { roots: ["Category:Root"], maxDepth: 1, maxFiles: 10 });
    expect(second.categories).toBe(0);
    expect(second.imported).toBe(0);
    expect(second.filesDiscovered).toBe(0);
  });

  test("maxDepth bounds recursion", async () => {
    const { db } = createDb(":memory:");
    migrateToLatest(db, MIGRATIONS);
    const summary = await runCrawl(db, await testDeps(), { roots: ["Category:Root"], maxDepth: 0, maxFiles: 10 });
    expect(summary.categories).toBe(1);
    expect(summary.filesDiscovered).toBe(1);
    expect(summary.imported).toBe(1);
  });
});

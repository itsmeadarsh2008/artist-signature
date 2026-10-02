/**
 * Offline importer demo: runs the real crawl + pipeline against stubbed
 * network responses, so no Wikimedia access is needed.
 *
 *   bun examples/import-stubbed.ts [--db=./data/demo.sqlite] [--assets=./assets-demo]
 */

import { join } from "node:path";
import { createDb, migrateToLatest } from "@artist-signatures/database";
import type { CommonsFileInput } from "@artist-signatures/parser";
import { runCrawl } from "../apps/importer/src/crawl";
import type { CategoryMember, CommonsClient } from "../apps/importer/src/wikimedia";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

const TREE: Record<string, CategoryMember[]> = {
  "Category:Demo Signatures": [
    { pageid: 1, title: "Category:Demo Signatures of Stub Star", kind: "subcat" },
    { pageid: 2, title: "File:Stub Star signature.svg", kind: "file" },
  ],
  "Category:Demo Signatures of Stub Star": [{ pageid: 3, title: "File:Stub Star restricted.png", kind: "file" }],
};

const FILES: Record<string, CommonsFileInput> = {
  "File:Stub Star signature.svg": {
    title: "File:Stub Star signature.svg",
    pageid: 2,
    revid: 201,
    url: "https://upload.wikimedia.org/stub.svg",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Stub_Star_signature.svg",
    mime: "image/svg+xml",
    extmetadata: { ImageDescription: { value: "Signature of Stub Star" }, LicenseShortName: { value: "PD" } },
    wikitext: "{{PD-signature}}\n[[Category:Demo Signatures of Stub Star]]",
  },
  "File:Stub Star restricted.png": {
    title: "File:Stub Star restricted.png",
    pageid: 3,
    revid: 202,
    url: "https://upload.wikimedia.org/restricted.png",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Stub_Star_restricted.png",
    mime: "image/png",
    extmetadata: { ImageDescription: { value: "Autograph of Stub Star" } },
    wikitext: "{{Non-free biog-pic}}",
  },
};

const client = {
  async *categoryMembers(title: string) {
    yield* TREE[title] ?? [];
  },
  async fetchFileMetadata(titles: string[]) {
    return titles.map((t) => FILES[t]).filter(Boolean);
  },
} as unknown as CommonsClient;

const dbPath = arg("db", "./data/demo.sqlite");
const assetDir = arg("assets", "./assets-demo");
const { db } = createDb(dbPath);
migrateToLatest(db, join(import.meta.dir, "../migrations"));

const summary = await runCrawl(
  db,
  {
    client,
    assetDir,
    downloadBytes: async () => ({ bytes: PNG, contentType: "image/png" }),
    lookupMusicBrainz: async (name: string) =>
      name === "Stub Star" ? { id: "33333333-3333-3333-3333-333333333333", name: "Stub Star" } : undefined,
    fetchWikidata: async () => undefined,
  },
  { roots: ["Category:Demo Signatures"], maxDepth: 2, maxFiles: 50, concurrency: 2 },
);
console.log(JSON.stringify(summary, null, 2));

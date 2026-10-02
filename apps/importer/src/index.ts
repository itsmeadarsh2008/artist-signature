/**
 * Importer CLI.
 *
 *   bun run apps/importer/src/index.ts --db=./data/signatures.sqlite \
 *     --assets=./assets --roots="Category:Signatures" --max-depth=4 \
 *     --max-files=500 --concurrency=4
 */

import { createDb, migrateToLatest } from "@artist-signatures/database";
import { runCrawl } from "./crawl";
import { CommonsClient } from "./wikimedia";

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const dbPath = arg("db", "./data/signatures.sqlite")!;
const assetDir = arg("assets", "./assets")!;
const roots = (arg("roots", "Category:Signatures")!).split(",").map((s) => s.trim()).filter(Boolean);
const maxDepth = parseInt(arg("max-depth", "4")!, 10);
const maxFiles = parseInt(arg("max-files", "500")!, 10);
const concurrency = parseInt(arg("concurrency", "4")!, 10);

console.log(`roots: ${roots.join(" | ")}`);
const { db } = createDb(dbPath);
const applied = migrateToLatest(db, new URL("../../../migrations", import.meta.url).pathname);
if (applied.length > 0) console.log(`applied migrations: ${applied.join(", ")}`);

const summary = await runCrawl(db, { client: new CommonsClient(), assetDir }, { roots, maxDepth, maxFiles, concurrency });
console.log(JSON.stringify(summary, null, 2));

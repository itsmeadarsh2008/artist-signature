/**
 * Resumable category crawl (SPEC §5, §24-25).
 *
 * Phase 1 — discovery: claim categories from `category_queue`, list members,
 * enqueue subcategories (depth+1, within maxDepth) and files as DISCOVERED.
 * Phase 2 — files: run every DISCOVERED item through the pipeline with a
 * bounded worker pool. A crash resumes from queue/item rows; nothing is
 * re-crawled unless explicitly requeued.
 */

import { sql } from "drizzle-orm";
import {
  claimNextCategory,
  enqueueCategory,
  finishCategory,
  finishRun,
  startRun,
  upsertImportItem,
  type Db,
} from "@artist-signatures/database";
import { buildKnownArtists, MAX_ATTEMPTS, processDiscoveredFile, type PipelineDeps } from "./pipeline";

export interface CrawlOptions {
  roots: string[];
  maxDepth?: number;
  maxCategories?: number;
  maxFiles?: number;
  concurrency?: number;
}

export interface CrawlSummary {
  jobId: string;
  categories: number;
  filesDiscovered: number;
  imported: number;
  unresolved: number;
  skipped: number;
  failed: number;
}

/** Bounded worker pool over items. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, size) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runCrawl(db: Db, deps: PipelineDeps, opts: CrawlOptions): Promise<CrawlSummary> {
  const maxDepth = opts.maxDepth ?? 4;
  const concurrency = opts.concurrency ?? 4;
  const jobId = startRun(db, "crawl");
  const summary: CrawlSummary = { jobId, categories: 0, filesDiscovered: 0, imported: 0, unresolved: 0, skipped: 0, failed: 0 };

  try {
    for (const root of opts.roots) enqueueCategory(db, root, 0);

    // Phase 1: category discovery.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (opts.maxCategories !== undefined && summary.categories >= opts.maxCategories) break;
      const cat = claimNextCategory(db);
      if (!cat) break;
      try {
        for await (const member of deps.client.categoryMembers(cat.categoryTitle)) {
          if (member.kind === "subcat") {
            if (cat.depth + 1 <= maxDepth) enqueueCategory(db, member.title, cat.depth + 1);
          } else {
            upsertImportItem(db, member.title, "DISCOVERED");
            summary.filesDiscovered++;
          }
        }
        finishCategory(db, cat.categoryTitle);
      } catch (err) {
        finishCategory(db, cat.categoryTitle, err instanceof Error ? err.message : String(err));
      }
      summary.categories++;
    }

    // Phase 2: file pipeline. Collect first (bounded by maxFiles), then pool.
    const due = db.all<{ sourceTitle: string }>(
      sql`SELECT source_title AS sourceTitle FROM import_items WHERE state = 'DISCOVERED' OR (state = 'FAILED' AND attempts < ${MAX_ATTEMPTS});`,
    ).map((r) => r.sourceTitle);
    const batch = opts.maxFiles !== undefined ? due.slice(0, opts.maxFiles) : due;
    const known = buildKnownArtists(db);
    await pool(batch, concurrency, async (title) => {
      const outcome = await processDiscoveredFile(db, deps, title, known);
      if (outcome === "imported") summary.imported++;
      else if (outcome === "unresolved") summary.unresolved++;
      else if (outcome === "skipped") summary.skipped++;
      else summary.failed++;
    });

    finishRun(db, jobId, "completed", summary.imported + summary.unresolved + summary.skipped, summary.failed);
  } catch (err) {
    finishRun(db, jobId, "failed", summary.imported, summary.failed, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return summary;
}

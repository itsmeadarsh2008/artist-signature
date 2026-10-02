/**
 * Applies pending migrations to a SQLite database file.
 *
 *   bun run scripts/migrate.ts --db=./data/signatures.sqlite
 */

import { createDb, migrateToLatest } from "@artist-signatures/database";
import { join } from "node:path";

const hit = process.argv.find((a) => a.startsWith("--db="));
const dbPath = hit ? hit.slice("--db=".length) : "./data/signatures.sqlite";

const { db } = createDb(dbPath);
const applied = migrateToLatest(db, join(import.meta.dir, "../migrations"));
console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "already up to date");

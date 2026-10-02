/**
 * SQLite connection factory + file-based migration runner.
 *
 * Uses `bun:sqlite` (WAL mode, foreign keys enforced). PostgreSQL remains
 * the recommended production backend (SPEC §22); this module is the seam a
 * future `createPgDb` would slot into — query helpers in `queries.ts` take
 * a `Db`, not a concrete driver.
 */

import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema";

export type Db = BunSQLiteDatabase<typeof schema>;

export function createDb(path: string): { db: Db; sqlite: Database } {
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function splitStatements(text: string): string[] {
  return text
    .split(/-->\s*statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Applies every `*.sql` file in `migrationsDir` (sorted) exactly once,
 * tracked in `__applied_migrations`. Accepts drizzle-kit output (with
 * `-->` statement-breakpoint separators) and plain multi-statement files.
 * Returns the names of newly applied migrations.
 */
export function migrateToLatest(db: Db, migrationsDir: string): string[] {
  db.run(sql`CREATE TABLE IF NOT EXISTS __applied_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  const applied = new Set(
    db.all<{ name: string }>(sql`SELECT name FROM __applied_migrations;`).map((r) => r.name),
  );
  const done: string[] = [];
  const names = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const name of names) {
    if (applied.has(name)) continue;
    const text = readFileSync(join(migrationsDir, name), "utf8");
    db.transaction((tx) => {
      for (const stmt of splitStatements(text)) tx.run(sql.raw(stmt));
      tx.run(
        sql`INSERT INTO __applied_migrations (name, applied_at) VALUES (${name}, ${new Date().toISOString()});`,
      );
    });
    done.push(name);
  }
  return done;
}

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Rolls back the most recently applied migration (F5).
 *
 * Drizzle's migrator only knows how to go forward, so each reversible migration
 * has a hand-written `src/db/migrations-down/<tag>.down.sql`. This applies that
 * file and removes the migration's row from `__drizzle_migrations` in a single
 * transaction, so a later `npm run db:migrate` re-applies it cleanly.
 */

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const MIGRATIONS_DIR = path.resolve("src/db/migrations");
const DOWN_DIR = path.resolve("src/db/migrations-down");

export function rollbackLatest(sqlite: Database.Database): string {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };

  const applied = sqlite
    .prepare("SELECT created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
    .get() as { createdAt: number } | undefined;
  if (!applied) {
    throw new Error("No applied migrations to roll back.");
  }

  const entry = journal.entries.find((e) => e.when === Number(applied.createdAt));
  if (!entry) {
    throw new Error(`Applied migration (created_at=${applied.createdAt}) is not in the journal.`);
  }

  const downFile = path.join(DOWN_DIR, `${entry.tag}.down.sql`);
  if (!fs.existsSync(downFile)) {
    throw new Error(`Migration ${entry.tag} is not reversible: ${downFile} does not exist.`);
  }

  const statements = fs
    .readFileSync(downFile, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  sqlite.transaction(() => {
    for (const statement of statements) sqlite.exec(statement);
    sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(entry.when);
  })();

  return entry.tag;
}

// CLI entry point: `npm run db:rollback`
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("db", "migrateDown.ts"))) {
  await import("../env.js");
  const { sqlite } = await import("./client.js");
  const tag = rollbackLatest(sqlite);
  console.log(`Rolled back ${tag}.`);
  sqlite.close();
}

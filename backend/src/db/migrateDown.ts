import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Rolls back the most recently applied migration (F5).
 *
 * Drizzle's migrator only knows how to go forward, so each reversible migration
 * has a hand-written `src/db/migrations-down/<tag>.down.sql`. This applies that
 * file and removes the migration's row from `drizzle.__drizzle_migrations` in a
 * single transaction (PostgreSQL DDL is transactional, so a failure changes
 * nothing), and a later `npm run db:migrate` re-applies it cleanly.
 */

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const MIGRATIONS_DIR = path.resolve("src/db/migrations");
const DOWN_DIR = path.resolve("src/db/migrations-down");

export async function rollbackLatest(db: Db): Promise<string> {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };

  const { rows } = await db.execute<{ created_at: string | number }>(
    sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
  );
  const latest = rows[0];
  if (!latest) {
    throw new Error("No applied migrations to roll back.");
  }
  // bigint arrives as a string from node-postgres and as a number from PGlite.
  const appliedAt = Number(latest.created_at);

  const entry = journal.entries.find((e) => e.when === appliedAt);
  if (!entry) {
    throw new Error(`Applied migration (created_at=${appliedAt}) is not in the journal.`);
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

  await db.transaction(async (tx) => {
    for (const statement of statements) {
      await tx.execute(sql.raw(statement));
    }
    await tx.execute(sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when}`);
  });

  return entry.tag;
}

// CLI entry point: `npm run db:rollback`
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("db", "migrateDown.ts"))) {
  await import("../env.js");
  const { db, closeDb } = await import("./client.js");
  const tag = await rollbackLatest(db);
  console.log(`Rolled back ${tag}.`);
  await closeDb();
}

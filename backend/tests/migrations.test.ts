import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { rollbackLatest } from "../src/db/migrateDown.js";

/**
 * F5: 0001_auth_sessions is reversible — up, down, and up again leaves the
 * same schema — run against real PostgreSQL semantics (in-memory PGlite).
 */

let closeDb: (() => Promise<void>) | undefined;

async function freshDb() {
  process.env.DATABASE_URL = ":memory:";
  vi.resetModules();
  const client = await import("../src/db/client.js");
  closeDb = client.closeDb;
  return client;
}

async function tables(db: Db): Promise<string[]> {
  const { rows } = await db.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function appliedCount(db: Db): Promise<number> {
  const { rows } = await db.execute<{ n: number | string }>(
    sql`SELECT COUNT(*) AS n FROM drizzle.__drizzle_migrations`,
  );
  return Number(rows[0]?.n);
}

describe("reversible migration (F5)", () => {
  afterEach(async () => {
    await closeDb?.();
  });

  it("applies, rolls back and re-applies 0001_auth_sessions", async () => {
    const { db, runMigrations } = await freshDb();

    await runMigrations();
    const fullSchema = await tables(db);
    // Hand-predicted: 5 tables from 0000 plus 2 from 0001 (drizzle's bookkeeping lives in its own schema).
    expect(fullSchema).toEqual([
      "answers",
      "audit_log",
      "auth_sessions",
      "game_sessions",
      "oauth_login_states",
      "questions",
      "users",
    ]);
    expect(await appliedCount(db)).toBe(2);

    // Data in tables owned by 0000 must survive rolling back 0001.
    await db.execute(sql`INSERT INTO users (oidc_subject, email) VALUES ('sub-1', 'bart@example.com')`);

    expect(await rollbackLatest(db)).toBe("0001_auth_sessions");
    expect(await tables(db)).not.toContain("auth_sessions");
    expect(await tables(db)).not.toContain("oauth_login_states");
    expect(await appliedCount(db)).toBe(1);
    const { rows } = await db.execute<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM users`);
    expect(Number(rows[0]?.n)).toBe(1);

    await runMigrations();
    expect(await tables(db)).toEqual(fullSchema);
    expect(await appliedCount(db)).toBe(2);
  });

  it("refuses to roll back a migration that has no down file", async () => {
    const { db, runMigrations } = await freshDb();
    await runMigrations();
    await rollbackLatest(db); // 0001 has a down file
    await expect(rollbackLatest(db)).rejects.toThrow(/0000_init is not reversible/);
  });
});

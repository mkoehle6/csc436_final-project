import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { rollbackLatest } from "../src/db/migrateDown.js";

/**
 * F5: 0004, 0003, 0002 and 0001 are reversible — up, down, and up again leaves the same
 * schema — run against real PostgreSQL semantics (in-memory PGlite).
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

async function indexes(db: Db): Promise<string[]> {
  const { rows } = await db.execute<{ indexname: string }>(
    sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%_uq' ORDER BY indexname`,
  );
  return rows.map((r) => r.indexname);
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

  it("applies, rolls back and re-applies 0004, 0003, 0002 and 0001", async () => {
    const { db, runMigrations } = await freshDb();
    const hasReturnTo = async () =>
      (
        await db.execute(
          sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'oauth_login_states' AND column_name = 'return_to'`,
        )
      ).rows.length === 1;

    await runMigrations();
    const fullSchema = await tables(db);
    // Hand-predicted: 5 tables from 0000, 2 from 0001, 1 from 0003, 2 from 0004
    // (drizzle's bookkeeping lives in its own schema).
    expect(fullSchema).toEqual([
      "answers",
      "audit_log",
      "auth_sessions",
      "game_sessions",
      "live_events",
      "oauth_authorization_codes",
      "oauth_login_states",
      "oauth_refresh_tokens",
      "questions",
      "users",
    ]);
    expect(await appliedCount(db)).toBe(5);
    expect(await hasReturnTo()).toBe(true);
    const gameIndexes = ["answers_session_question_uq", "questions_category_prompt_uq"];
    expect(await indexes(db)).toEqual([gameIndexes[0], "oauth_codes_hash_uq", "oauth_refresh_hash_uq", gameIndexes[1]]);

    // 0004 down: MCP OAuth tables and the return_to column go, everything else stays.
    const withoutOauth = fullSchema.filter((t) => t !== "oauth_authorization_codes" && t !== "oauth_refresh_tokens");
    expect(await rollbackLatest(db)).toBe("0004_mcp_oauth");
    expect(await tables(db)).toEqual(withoutOauth);
    expect(await hasReturnTo()).toBe(false);
    expect(await indexes(db)).toEqual(gameIndexes);
    expect(await appliedCount(db)).toBe(4);

    // 0003 down: the live-event buffer goes, everything else stays.
    const without0003 = withoutOauth.filter((t) => t !== "live_events");
    expect(await rollbackLatest(db)).toBe("0003_live_events");
    expect(await tables(db)).toEqual(without0003);
    expect(await appliedCount(db)).toBe(3);
    expect(await indexes(db)).toEqual(gameIndexes);

    // 0002 down: the unique indexes go, the tables stay.
    expect(await rollbackLatest(db)).toBe("0002_unique_questions_answers");
    expect(await indexes(db)).toEqual([]);
    expect(await tables(db)).toEqual(without0003);
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
    expect(await hasReturnTo()).toBe(true);
    expect(await appliedCount(db)).toBe(5);
  });

  it("0002 upgrades a database that already holds duplicate questions (as staging/prod did)", async () => {
    const { db, runMigrations } = await freshDb();
    await runMigrations();
    await rollbackLatest(db); // 0004
    await rollbackLatest(db); // 0003
    await rollbackLatest(db); // 0002: back to the pre-0002 schema the deployed databases had

    // Pre-0002 data: the same prompt stored three times, one copy answered by a player.
    const q = (id: number) =>
      sql`INSERT INTO questions (id, prompt, category, correct_answer, choices, source_entity_id)
          OVERRIDING SYSTEM VALUE VALUES (${id}, 'What is Cora''s occupation?', 'character', 'Waiter', '["Waiter","Cook","Clown","Pilot"]', 1)`;
    await db.execute(q(1));
    await db.execute(q(2));
    await db.execute(q(3));
    await db.execute(sql`INSERT INTO users (id, oidc_subject, email) OVERRIDING SYSTEM VALUE VALUES (1, 's', 'moe@example.com')`);
    await db.execute(sql`INSERT INTO game_sessions (id, user_id) OVERRIDING SYSTEM VALUE VALUES (1, 1)`);
    await db.execute(sql`INSERT INTO answers (session_id, question_id, selected_answer, is_correct) VALUES (1, 2, 'Waiter', true)`);

    await runMigrations(); // must not fail on the new unique index

    // Hand-predicted: unreferenced copies 1 and 3 are cleared; answered copy 2 is kept.
    const { rows } = await db.execute<{ id: number }>(sql`SELECT id FROM questions ORDER BY id`);
    expect(rows.map((r) => Number(r.id))).toEqual([2]);
    expect(await indexes(db)).toEqual([
      "answers_session_question_uq",
      "oauth_codes_hash_uq",
      "oauth_refresh_hash_uq",
      "questions_category_prompt_uq",
    ]);
  });

  it("refuses to roll back a migration that has no down file", async () => {
    const { db, runMigrations } = await freshDb();
    await runMigrations();
    await rollbackLatest(db); // 0004 has a down file
    await rollbackLatest(db); // 0003 has a down file
    await rollbackLatest(db); // 0002 has a down file
    await rollbackLatest(db); // 0001 has a down file
    await expect(rollbackLatest(db)).rejects.toThrow(/0000_init is not reversible/);
  });
});

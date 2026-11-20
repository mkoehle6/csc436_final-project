import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { rollbackLatest } from "../src/db/migrateDown.js";

/** F5: 0001_auth_sessions is reversible — up, down, and up again leaves the same schema. */

const tables = (sqlite: Database.Database) =>
  (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
const appliedCount = (sqlite: Database.Database) =>
  (sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;

describe("reversible migration (F5)", () => {
  it("applies, rolls back and re-applies 0001_auth_sessions", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);
    const migrateUp = () => migrate(db, { migrationsFolder: "./src/db/migrations" });

    migrateUp();
    const fullSchema = tables(sqlite);
    // Hand-predicted: 5 tables from 0000, 2 from 0001, plus drizzle's bookkeeping table.
    expect(fullSchema).toEqual([
      "__drizzle_migrations",
      "answers",
      "audit_log",
      "auth_sessions",
      "game_sessions",
      "oauth_login_states",
      "questions",
      "users",
    ]);
    expect(appliedCount(sqlite)).toBe(2);

    // Data in tables owned by 0000 must survive rolling back 0001.
    sqlite.prepare("INSERT INTO users (oidc_subject, email) VALUES ('sub-1', 'bart@example.com')").run();

    expect(rollbackLatest(sqlite)).toBe("0001_auth_sessions");
    expect(tables(sqlite)).not.toContain("auth_sessions");
    expect(tables(sqlite)).not.toContain("oauth_login_states");
    expect(appliedCount(sqlite)).toBe(1);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(1);

    migrateUp();
    expect(tables(sqlite)).toEqual(fullSchema);
    expect(appliedCount(sqlite)).toBe(2);
    sqlite.close();
  });

  it("refuses to roll back a migration that has no down file", () => {
    const sqlite = new Database(":memory:");
    migrate(drizzle(sqlite), { migrationsFolder: "./src/db/migrations" });
    rollbackLatest(sqlite); // 0001 has a down file
    expect(() => rollbackLatest(sqlite)).toThrow(/0000_burly_killraven is not reversible/);
    sqlite.close();
  });
});

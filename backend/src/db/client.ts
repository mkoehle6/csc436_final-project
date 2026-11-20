import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * One database layer, two PostgreSQL engines, chosen by DATABASE_URL:
 *
 *  - `postgres://…` / `postgresql://…` → a real PostgreSQL server via node-postgres.
 *    Used on Render (staging and production). Add `?sslmode=require` when
 *    connecting over Render's *external* URL; the internal URL needs no TLS.
 *  - anything else → PGlite, PostgreSQL compiled to WebAssembly and running
 *    in-process. A directory path (default ./data/pglite) persists across
 *    restarts for local development; `:memory:` is used by the tests.
 *
 * Both run the same SQL and the same migrations, so local dev and tests
 * exercise real Postgres semantics without installing Postgres or Docker.
 */

export const MIGRATIONS_FOLDER = "./src/db/migrations";

const url = process.env.DATABASE_URL ?? "./data/pglite";
export const driver: "postgres" | "pglite" = /^postgres(ql)?:\/\//.test(url) ? "postgres" : "pglite";

/**
 * The app is typed against the node-postgres flavour of Drizzle. PGlite's
 * Drizzle database exposes the same query-builder API (select/insert/update/
 * delete/returning/transaction/execute → `{ rows }`), so it is cast to the
 * same type; only the driver-specific migrate() call differs, handled below.
 */
export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let pglite: PGlite | undefined;

function createDb(): Db {
  if (driver === "postgres") {
    pool = new pg.Pool({ connectionString: url, max: 10 });
    return drizzleNodePg(pool, { schema });
  }
  if (url === ":memory:") {
    pglite = new PGlite();
  } else {
    fs.mkdirSync(path.dirname(path.resolve(url)), { recursive: true });
    pglite = new PGlite(url);
  }
  return drizzlePglite(pglite, { schema }) as unknown as Db;
}

export const db: Db = createDb();

export async function runMigrations(): Promise<void> {
  if (pool) {
    await migrateNodePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    await migratePglite(db as unknown as Parameters<typeof migratePglite>[0], {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
  }
}

/** Closes the connection pool / embedded database; call once on shutdown. */
export async function closeDb(): Promise<void> {
  await pool?.end();
  await pglite?.close();
}

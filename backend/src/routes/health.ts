import { sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";

export const healthRouter = Router();

const DB_CHECK_TIMEOUT_MS = 2000;

/**
 * Which build is running. Render sets RENDER_GIT_COMMIT for every deploy;
 * GIT_COMMIT can be set elsewhere (CI, local); otherwise null.
 */
const commit = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null;
const startedAt = new Date().toISOString();

async function databaseReachable(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.execute(sql`SELECT 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("database check timed out")), DB_CHECK_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /healthz (D4, D10). Render routes traffic to a new deploy only once this
 * returns 200, so it checks the one dependency the app cannot work without:
 * the database. The Simpsons API is deliberately NOT checked: the app degrades
 * gracefully without it (F10), so its outages must not take the service down.
 *
 * Also reports the deployed commit, so anyone can verify which version each
 * environment runs (e.g. that a promotion reached production).
 */
healthRouter.get("/healthz", async (_req, res) => {
  const dbOk = await databaseReachable();
  res.setHeader("Cache-Control", "no-store");
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "unavailable",
    checks: { database: dbOk ? "ok" : "unreachable" },
    commit,
    startedAt,
    timestamp: new Date().toISOString(),
  });
});

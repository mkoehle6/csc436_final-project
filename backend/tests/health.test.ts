import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { freshAppWithDb } from "./helpers.js";

/** D4: /healthz gates deploys, so it must report the database honestly and name the build. */

afterEach(() => {
  delete process.env.RENDER_GIT_COMMIT;
});

describe("GET /healthz", () => {
  it("reports ok, the database check and the deployed commit", async () => {
    process.env.RENDER_GIT_COMMIT = "670a5cc4e4c0b3549ae09b2f35da19e448325432";
    const { app, close } = await freshAppWithDb();

    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      status: "ok",
      checks: { database: "ok" },
      commit: "670a5cc4e4c0b3549ae09b2f35da19e448325432",
    });
    await close();
  });

  it("sends the D7 security headers and does not advertise the framework", async () => {
    const { app, close } = await freshAppWithDb();

    const res = await request(app).get("/healthz");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains; preload");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    await close();
  });

  it("returns 503 when the database is unreachable, so Render will not route traffic to it", async () => {
    const { app, close } = await freshAppWithDb();
    await close(); // the database goes away

    const res = await request(app).get("/healthz");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "unavailable", checks: { database: "unreachable" }, commit: null });
  });
});

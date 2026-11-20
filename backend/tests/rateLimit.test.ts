import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { freshAppWithDb } from "./helpers.js";

/**
 * S1: the login endpoints allow 20 requests per minute per client.
 * Behind Render's load balancer the client is identified from X-Forwarded-For,
 * which is only trusted when TRUST_PROXY says a proxy is actually there.
 * Expected counts below were predicted by hand: requests 1–20 pass, 21 is refused.
 */

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  delete process.env.TRUST_PROXY;
});

async function appWith(trustProxy: string | undefined) {
  if (trustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = trustProxy;
  process.env.GOOGLE_CLIENT_ID = "test-client";
  const fresh = await freshAppWithDb();
  close = fresh.close;
  return fresh.app;
}

async function hitLogin(app: Awaited<ReturnType<typeof appWith>>, times: number, forwardedFor?: string) {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) {
    const req = request(app).get("/auth/login");
    if (forwardedFor) req.set("X-Forwarded-For", forwardedFor);
    statuses.push((await req).status);
  }
  return statuses;
}

describe("login rate limit (S1)", () => {
  it("returns 429 with Retry-After and the standard error shape on the 21st request", async () => {
    const app = await appWith(undefined);
    const statuses = await hitLogin(app, 20);
    expect(statuses.every((s) => s === 302)).toBe(true);

    const blocked = await request(app).get("/auth/login");
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("behind one trusted proxy, limits each client separately (by X-Forwarded-For)", async () => {
    const app = await appWith("1");
    await hitLogin(app, 20, "203.0.113.7");
    expect((await hitLogin(app, 1, "203.0.113.7"))[0]).toBe(429);
    // A different visitor behind the same load balancer is unaffected.
    expect((await hitLogin(app, 1, "198.51.100.9"))[0]).toBe(302);
  });

  it("without TRUST_PROXY, a spoofed X-Forwarded-For cannot dodge the limit", async () => {
    const app = await appWith(undefined);
    await hitLogin(app, 20, "203.0.113.7");
    // Header ignored: same socket address, so still limited.
    expect((await hitLogin(app, 1, "198.51.100.9"))[0]).toBe(429);
  });
});

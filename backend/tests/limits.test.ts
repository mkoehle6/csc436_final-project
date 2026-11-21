import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshAppWithDb, useTestSigningKey } from "./helpers.js";

/**
 * S1: separate limits for writes (per user), Simpsons-API-backed reads and
 * token refresh, standard RateLimit headers, and protection of the provider
 * from bursts (single-flight + cooldown). Counts were predicted by hand:
 * with a limit of N, requests 1..N pass and request N+1 gets 429.
 */

type Fresh = Awaited<ReturnType<typeof freshAppWithDb>>;
let app: Fresh["app"];
let db: Fresh["db"];
let close: Fresh["close"];
let schema: typeof import("../src/db/schema.js");
let providerCalls = 0;
const realFetch = global.fetch;

function stubProvider(mode: "up" | "down", delayMs = 0) {
  providerCalls = 0;
  global.fetch = vi.fn(async () => {
    providerCalls += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (mode === "down") return new Response(null, { status: 503 });
    const results = Array.from({ length: 20 }, (_, i) => ({
      id: providerCalls * 100 + i, name: `Resident ${providerCalls}-${i}`, occupation: `Job ${providerCalls}-${i}`, portrait_path: "/x.webp", phrases: [],
    }));
    return new Response(JSON.stringify({ count: 20, next: null, prev: null, pages: 60, results }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function seedQuestions(n: number) {
  await db.insert(schema.questions).values(
    Array.from({ length: n }, (_, i) => ({
      prompt: `Seed ${i}?`, category: "character" as const, correctAnswer: "A", choices: ["A", "B", "C", "D"], imagePath: null, sourceEntityId: i + 1,
    })),
  );
}

async function bearerFor(email: string) {
  const [user] = await db.insert(schema.users).values({ oidcSubject: `sub-${email}`, email }).returning({ id: schema.users.id });
  const { issueAccessToken } = await import("../src/auth/tokens.js");
  return `Bearer ${(await issueAccessToken({ id: user!.id, role: "viewer" })).accessToken}`;
}

beforeEach(async () => {
  await useTestSigningKey();
  ({ app, db, close } = await freshAppWithDb());
  schema = await import("../src/db/schema.js");
});

afterEach(async () => {
  global.fetch = realFetch;
  await close();
});

describe("write limit (30/min per signed-in user)", () => {
  it("refuses the 31st write with 429 + RateLimit headers, without affecting another player", async () => {
    const bart = await bearerFor("bart@example.com");
    const lisa = await bearerFor("lisa@example.com");

    const first = await request(app).post("/api/sessions").set("Authorization", bart);
    expect(first.status).toBe(201);
    expect(first.headers["ratelimit-limit"]).toBe("30");
    expect(first.headers["ratelimit-remaining"]).toBe("29");
    expect(first.headers["ratelimit-policy"]).toBe("30;w=60");

    for (let i = 2; i <= 30; i++) {
      expect((await request(app).post("/api/sessions").set("Authorization", bart)).status).toBe(201);
    }
    const blocked = await request(app).post("/api/sessions").set("Authorization", bart);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["ratelimit-remaining"]).toBe("0");
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(blocked.body.error).toMatchObject({ code: "RATE_LIMITED" });
    expect(blocked.body.error.message).toMatch(/write/);

    // Same IP, different user: counted separately because the key is the token's subject.
    expect((await request(app).post("/api/sessions").set("Authorization", lisa)).status).toBe(201);
  });
});

describe("Simpsons-API-backed read limit (30/min per IP)", () => {
  it("refuses the 31st GET /api/questions", async () => {
    stubProvider("up");
    await seedQuestions(60); // full bank: no provider calls needed
    for (let i = 1; i <= 30; i++) {
      expect((await request(app).get("/api/questions?count=1")).status).toBe(200);
    }
    const blocked = await request(app).get("/api/questions?count=1");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.message).toMatch(/question/);
  });
});

describe("token refresh limit (60/min per IP)", () => {
  it("refuses the 61st POST /auth/token", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "http://localhost:5173";
    const hit = () => request(app).post("/auth/token").set("Origin", "http://localhost:5173");
    for (let i = 1; i <= 60; i++) expect((await hit()).status).toBe(401); // not signed in, but counted
    expect((await hit()).status).toBe(429);
  });
});

describe("protecting The Simpsons API from bursts", () => {
  it("single-flight: 5 simultaneous requests on an empty bank share one top-up", async () => {
    stubProvider("up", 200); // slow provider, so the requests overlap
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(app).get("/api/questions?count=5")));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    // Hand-predicted: one top-up = 2 pages (20 usable per page, 20 + 3 needed). Five
    // independent top-ups would have made 10 calls.
    expect(providerCalls).toBe(2);
  });

  it("cooldown: after a failed top-up, the next request does not call the provider again", async () => {
    stubProvider("down");
    await seedQuestions(3); // something to serve while degraded
    const first = await request(app).get("/api/questions");
    expect(first.body.degraded).toBe(true);
    const callsAfterFirst = providerCalls; // 3 pages × 3 attempts = 9

    const second = await request(app).get("/api/questions");
    expect(second.status).toBe(200);
    expect(second.body.questions).toHaveLength(3);
    expect(providerCalls).toBe(callsAfterFirst); // no new provider traffic within the cooldown
  });
});

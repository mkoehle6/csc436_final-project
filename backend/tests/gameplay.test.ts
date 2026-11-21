import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshAppWithDb, useTestSigningKey } from "./helpers.js";

/**
 * Gameplay API: the question bank (no answers leaked, no per-view writes,
 * graceful degradation), anonymous answer checks, and scored game sessions
 * (201 + Location, 404, 409). The Simpsons API is stubbed; no network calls.
 * Expected values were predicted by hand before running.
 */

type Fresh = Awaited<ReturnType<typeof freshAppWithDb>>;
let app: Fresh["app"];
let db: Fresh["db"];
let close: Fresh["close"];
let schema: typeof import("../src/db/schema.js");
let simpsonsCalls = 0;

const realFetch = global.fetch;

/** Stub The Simpsons API: either a page of characters, or "down" (503). */
function stubSimpsons(mode: "up" | "down") {
  simpsonsCalls = 0;
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("thesimpsonsapi.com")) return realFetch(input);
    simpsonsCalls += 1;
    if (mode === "down") return new Response(null, { status: 503 });
    const characters = [
      ["Homer Simpson", "Safety Inspector"],
      ["Marge Simpson", "Homemaker"],
      ["Moe Szyslak", "Bartender"],
      ["Apu Nahasapeemapetilon", "Kwik-E-Mart clerk"],
      ["Edna Krabappel", "Fourth grade teacher at Springfield Elementary School (formerly)"],
      ["Female Unnamed with brown hair and white science coat", "Springfield Nuclear Power Plant"],
      ["Guy Incognito", "Unknown"],
    ].map(([name, occupation], i) => ({ id: i + 1, name, occupation, portrait_path: `/character/${i + 1}.webp`, phrases: [] }));
    return new Response(JSON.stringify({ count: characters.length, next: null, prev: null, pages: 60, results: characters }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function seedQuestions(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({
    prompt: `Seed question ${i + 1}?`,
    category: "character" as const,
    correctAnswer: "Right",
    choices: ["Right", "Wrong A", "Wrong B", "Wrong C"],
    imagePath: null,
    sourceEntityId: i + 1,
  }));
  return db.insert(schema.questions).values(rows).returning({ id: schema.questions.id });
}

async function bearerFor(email: string, role: "viewer" | "operator" = "viewer") {
  const [user] = await db
    .insert(schema.users)
    .values({ oidcSubject: `sub-${email}`, email, role })
    .returning({ id: schema.users.id });
  const { issueAccessToken } = await import("../src/auth/tokens.js");
  const { accessToken } = await issueAccessToken({ id: user!.id, role });
  return { userId: user!.id, auth: `Bearer ${accessToken}` };
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

describe("GET /api/questions (question bank)", () => {
  it("serves a full bank without calling The Simpsons API and never includes the answer", async () => {
    stubSimpsons("up");
    await seedQuestions(60);
    const res = await request(app).get("/api/questions?count=9");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.degraded).toBe(false);
    expect(res.body.questions).toHaveLength(9);
    for (const q of res.body.questions) {
      expect(Object.keys(q).sort()).toEqual(["category", "choices", "id", "imagePath", "prompt"]);
    }
    expect(simpsonsCalls).toBe(0); // no third-party call, no write, once the bank is full
  });

  it("tops up an empty bank, skipping unnamed extras and 'Unknown' occupations", async () => {
    stubSimpsons("up");
    const res = await request(app).get("/api/questions?count=9");

    expect(res.status).toBe(200);
    // Hand-predicted: 7 characters, 2 filtered out → 5 usable → 5 questions.
    expect(res.body.questions).toHaveLength(5);
    const prompts: string[] = res.body.questions.map((q: { prompt: string }) => q.prompt);
    expect(prompts.some((p) => p.includes("Unnamed"))).toBe(false);
    expect(prompts.some((p) => p.includes("Guy Incognito"))).toBe(false);
    const choices = res.body.questions.flatMap((q: { choices: string[] }) => q.choices);
    expect(choices).not.toContain("Unknown");
    expect(choices).toContain("Fourth grade teacher at Springfield Elementary School"); // "(formerly)" stripped
  });

  it("does not store duplicates when the bank is topped up again from the same data", async () => {
    process.env.QUESTION_TOPUP_COOLDOWN_MS = "0"; // allow the second top-up this test is about
    try {
      stubSimpsons("up");
      await request(app).get("/api/questions");
      await request(app).get("/api/questions");
      expect(simpsonsCalls).toBeGreaterThan(1); // the second request really did top up again
      const all = await db.select().from(schema.questions);
      expect(all).toHaveLength(5); // same 5 prompts both times; the unique index absorbs the repeat
    } finally {
      delete process.env.QUESTION_TOPUP_COOLDOWN_MS;
    }
  });

  it("degrades gracefully: serves the existing bank when the provider is down", async () => {
    stubSimpsons("down");
    await seedQuestions(5);
    const res = await request(app).get("/api/questions?count=9");
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.questions).toHaveLength(5);
  });

  it("warm-up fills an empty bank to the minimum at startup, then stops", async () => {
    // 20 characters unique to each call (not each page: top-ups pick random pages,
    // and a repeated page would correctly yield duplicates the bank skips), so
    // every top-up adds exactly 20 new questions.
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      const results = Array.from({ length: 20 }, (_, i) => ({
        id: call * 100 + i, name: `Resident ${call}-${i}`, occupation: `Job ${call}-${i}`, portrait_path: "/x.webp", phrases: [],
      }));
      return new Response(JSON.stringify({ count: 20, next: null, prev: null, pages: 60, results }), { status: 200 });
    }) as unknown as typeof fetch;

    const { warmUp, MIN_BANK_SIZE } = await import("../src/lib/questionBank.js");
    const log: string[] = [];
    await warmUp((m) => log.push(m));

    const all = await db.select().from(schema.questions);
    // Hand-predicted: usually 3 top-ups × 20 = 60. But top-ups pick random pages and
    // the Simpsons API client caches pages, so a repeated page yields duplicates the
    // bank skips, and one extra top-up may run. Property that must hold: it reaches
    // the minimum, overshoots by at most one batch (20), and reports ready.
    expect(all.length).toBeGreaterThanOrEqual(MIN_BANK_SIZE);
    expect(all.length).toBeLessThanOrEqual(MIN_BANK_SIZE + 20);
    expect(log.at(-1)).toBe(`question bank ready: character has ${all.length} questions`);
  });

  it("returns 502 only when the bank is empty and the provider is down", async () => {
    stubSimpsons("down");
    const res = await request(app).get("/api/questions");
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });
});

describe("POST /api/questions/:id/check (anonymous play)", () => {
  it("says whether the choice is right and reveals the answer afterwards", async () => {
    const [q] = await seedQuestions(1);
    const right = await request(app).post(`/api/questions/${q!.id}/check`).send({ selectedAnswer: "Right" });
    expect(right.status).toBe(200);
    expect(right.body).toMatchObject({ isCorrect: true, correctAnswer: "Right" });

    const wrong = await request(app).post(`/api/questions/${q!.id}/check`).send({ selectedAnswer: "Wrong A" });
    expect(wrong.body).toMatchObject({ isCorrect: false, correctAnswer: "Right" });
  });

  it("returns 404 for an unknown question and 400 for a missing answer", async () => {
    expect((await request(app).post("/api/questions/999/check").send({ selectedAnswer: "x" })).status).toBe(404);
    const [q] = await seedQuestions(1);
    const bad = await request(app).post(`/api/questions/${q!.id}/check`).send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("game sessions (signed-in play)", () => {
  it("scores answers on the server: 201 + Location, running score, 409 on a repeat", async () => {
    const [q1, q2] = await seedQuestions(2);
    const { userId, auth } = await bearerFor("bart@example.com");

    const started = await request(app).post("/api/sessions").set("Authorization", auth);
    expect(started.status).toBe(201);
    const sessionId = started.body.id as number;

    const first = await request(app)
      .post(`/api/sessions/${sessionId}/answers`)
      .set("Authorization", auth)
      .send({ questionId: q1!.id, selectedAnswer: "Right" });
    expect(first.status).toBe(201);
    expect(first.headers.location).toBe(`/api/sessions/${sessionId}`);
    // Hand-predicted: 1 of 1 correct → 100%, 10 points.
    expect(first.body).toMatchObject({ isCorrect: true, correctAnswer: "Right", score: { correctCount: 1, totalCount: 1, percentage: 100, points: 10 } });

    const second = await request(app)
      .post(`/api/sessions/${sessionId}/answers`)
      .set("Authorization", auth)
      .send({ questionId: q2!.id, selectedAnswer: "Wrong B" });
    // Hand-predicted: 1 of 2 correct → 50%, 10 points.
    expect(second.body).toMatchObject({ isCorrect: false, correctAnswer: "Right", score: { correctCount: 1, totalCount: 2, percentage: 50, points: 10 } });

    const repeat = await request(app)
      .post(`/api/sessions/${sessionId}/answers`)
      .set("Authorization", auth)
      .send({ questionId: q1!.id, selectedAnswer: "Wrong A" });
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe("CONFLICT");

    const [session] = await db.select().from(schema.gameSessions).where(eq(schema.gameSessions.id, sessionId));
    expect(session?.score).toBe(10);
    const audited = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "answer.submit"));
    expect(audited.map((a) => a.actorUserId)).toEqual([userId, userId]); // the 409 attempt is not recorded
  });

  it("hides other players' sessions (404) and requires sign-in (401)", async () => {
    const [q] = await seedQuestions(1);
    const owner = await bearerFor("lisa@example.com");
    const other = await bearerFor("nelson@example.com");
    const { body: session } = await request(app).post("/api/sessions").set("Authorization", owner.auth);

    const intruder = await request(app)
      .post(`/api/sessions/${session.id}/answers`)
      .set("Authorization", other.auth)
      .send({ questionId: q!.id, selectedAnswer: "Right" });
    expect(intruder.status).toBe(404);

    const anonymous = await request(app).post(`/api/sessions/${session.id}/answers`).send({ questionId: q!.id, selectedAnswer: "Right" });
    expect(anonymous.status).toBe(401);
  });
});

describe("operator question management (409 cases)", () => {
  it("refuses a duplicate question and refuses to delete an answered question", async () => {
    const op = await bearerFor("skinner@example.com", "operator");
    const body = { prompt: "Who runs the Kwik-E-Mart?", category: "character", correctAnswer: "Apu", choices: ["Apu", "Moe", "Homer", "Ned"], sourceEntityId: 4 };

    const created = await request(app).post("/api/questions").set("Authorization", op.auth).send(body);
    expect(created.status).toBe(201);
    expect(created.headers.location).toBe(`/api/questions/${created.body.id}`);
    expect((await request(app).post("/api/questions").set("Authorization", op.auth).send(body)).status).toBe(409);

    const player = await bearerFor("milhouse@example.com");
    const { body: session } = await request(app).post("/api/sessions").set("Authorization", player.auth);
    await request(app).post(`/api/sessions/${session.id}/answers`).set("Authorization", player.auth).send({ questionId: created.body.id, selectedAnswer: "Apu" });

    const del = await request(app).delete(`/api/questions/${created.body.id}`).set("Authorization", op.auth);
    expect(del.status).toBe(409);
  });
});

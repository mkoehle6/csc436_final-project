import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const verifyAccessToken = vi.fn();

// Mocked once at module scope (hoisted by vitest) so every dynamic import of
// src/app.js within this file resolves auth/jwt.js to this stub instead of
// making a real OIDC/JWKS call.
vi.mock("../src/auth/jwt.js", () => ({
  verifyAccessToken: (...args: unknown[]) => verifyAccessToken(...args),
}));

/**
 * Validation + authorization tests (Q1). Auth is stubbed via mocking
 * verifyAccessToken so no real OIDC provider call is made.
 */
describe("API validation and authorization", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = ":memory:";
    vi.resetModules();
    verifyAccessToken.mockReset();
    verifyAccessToken.mockRejectedValue(new Error("no token configured for this test"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an invalid questions query with 400 and the standard error shape", async () => {
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app).get("/api/questions?count=0");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 for an anonymous write request", async () => {
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app)
      .post("/api/questions")
      .send({
        prompt: "Test?",
        category: "character",
        correctAnswer: "A",
        choices: ["A", "B", "C", "D"],
        sourceEntityId: 1,
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for a viewer attempting a write", async () => {
    verifyAccessToken.mockResolvedValue({ sub: "42", role: "viewer" });

    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app)
      .post("/api/questions")
      .set("Authorization", "Bearer fake-viewer-token")
      .send({
        prompt: "Test?",
        category: "character",
        correctAnswer: "A",
        choices: ["A", "B", "C", "D"],
        sourceEntityId: 1,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("reports healthy status on /healthz", async () => {
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

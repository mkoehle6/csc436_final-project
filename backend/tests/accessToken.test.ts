import { generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshAppWithDb, TEST_AUDIENCE, TEST_ISSUER, TEST_KID, useTestSigningKey } from "./helpers.js";

/**
 * F8: server-side token validation, one failing test per check, exercised
 * through the real middleware (nothing mocked). Every request targets
 * POST /api/questions with an empty body, so:
 *   - a token that passes every check reaches validation  -> 400 VALIDATION_ERROR
 *   - a token failing signature/iss/aud/exp/typ            -> 401 UNAUTHORIZED
 *   - a valid token lacking the scope or role              -> 403 FORBIDDEN
 * Expected statuses below were predicted by hand before running.
 */

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let signingKey: SigningKey;
let app: Awaited<ReturnType<typeof freshAppWithDb>>["app"];

const now = () => Math.floor(Date.now() / 1000);

function token(overrides: {
  key?: SigningKey;
  iss?: string;
  aud?: string;
  exp?: number;
  typ?: string;
  role?: string;
  scope?: string;
} = {}) {
  return new SignJWT({
    role: overrides.role ?? "operator",
    scope: overrides.scope ?? "trivia:read trivia:play questions:write",
  })
    .setProtectedHeader({ alg: "ES256", kid: TEST_KID, typ: overrides.typ ?? "at+jwt" })
    .setIssuer(overrides.iss ?? TEST_ISSUER)
    .setAudience(overrides.aud ?? TEST_AUDIENCE)
    .setSubject("1")
    .setIssuedAt(now() - 60)
    .setExpirationTime(overrides.exp ?? now() + 600)
    .sign(overrides.key ?? signingKey);
}

const postQuestion = async (bearer: string) =>
  request(app).post("/api/questions").set("Authorization", `Bearer ${bearer}`).send({});

describe("access-token validation (F8)", () => {
  let closeDb: () => Promise<void>;

  beforeAll(async () => {
    signingKey = await useTestSigningKey();
    ({ app, close: closeDb } = await freshAppWithDb());
  });

  afterAll(async () => {
    await closeDb();
  });

  it("control: a token passing every check reaches body validation (400)", async () => {
    const res = await postQuestion(await token());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("signature: rejects a token signed by a different key (401)", async () => {
    const { privateKey: attackerKey } = await generateKeyPair("ES256");
    const res = await postQuestion(await token({ key: attackerKey }));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("signature: rejects an unsigned alg=none token (401)", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: TEST_ISSUER, aud: TEST_AUDIENCE, sub: "1", role: "operator", iat: now(), exp: now() + 600 }),
    ).toString("base64url");
    const res = await postQuestion(`${header}.${payload}.`);
    expect(res.status).toBe(401);
  });

  it("issuer: rejects a token from another issuer (401)", async () => {
    const res = await postQuestion(await token({ iss: "https://evil.example" }));
    expect(res.status).toBe(401);
  });

  it("audience: rejects a token minted for another API (401)", async () => {
    const res = await postQuestion(await token({ aud: "some-other-api" }));
    expect(res.status).toBe(401);
  });

  it("expiry: rejects an expired token (401)", async () => {
    const res = await postQuestion(await token({ exp: now() - 30 }));
    expect(res.status).toBe(401);
  });

  it("type: rejects a JWT that is not an access token, e.g. an ID token (401)", async () => {
    const res = await postQuestion(await token({ typ: "JWT" }));
    expect(res.status).toBe(401);
  });

  it("scope: rejects an operator token without questions:write (403)", async () => {
    const res = await postQuestion(await token({ scope: "trivia:read trivia:play" }));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("questions:write");
  });

  it("role: rejects a viewer even if the token somehow carries the scope (403)", async () => {
    const res = await postQuestion(await token({ role: "viewer" }));
    expect(res.status).toBe(403);
  });

  it("role: rejects a token whose role claim is not a known role (401)", async () => {
    const res = await postQuestion(await token({ role: "admin" }));
    expect(res.status).toBe(401);
  });

  it("tokens issued by the backend verify and carry role-derived scopes", async () => {
    const { issueAccessToken } = await import("../src/auth/tokens.js");
    const { verifyAccessToken } = await import("../src/auth/jwt.js");
    const issued = await issueAccessToken({ id: 7, role: "viewer" });
    const claims = await verifyAccessToken(issued.accessToken);
    // Hand-predicted: sub "7", viewer gets read+play but not questions:write.
    expect(claims.sub).toBe("7");
    expect(claims.role).toBe("viewer");
    expect(claims.scope).toBe("trivia:read trivia:play");
  });

  it("publishes only the public key at /.well-known/jwks.json", async () => {
    const res = await request(app).get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", kid: TEST_KID, alg: "ES256" });
    expect(res.body.keys[0]).not.toHaveProperty("d");
  });
});

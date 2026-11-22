import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshAppWithDb, getCookie, useTestSigningKey } from "./helpers.js";

/**
 * F7 end to end, with Google replaced by a local stub that behaves like the
 * real token endpoint: it checks the PKCE verifier against the challenge from
 * the authorization request and returns an RS256 ID token carrying the nonce.
 * No real Google call is made.
 */

const APP = "http://localhost:5173";
const CLIENT_ID = "test-client.apps.googleusercontent.com";

let googleKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let stub: http.Server;
/** What the stub expects, captured from the /auth/login redirect. */
let expected: { codeChallenge: string; nonce: string } | null = null;
/** Lets a test make the stub return a different nonce than requested. */
let nonceOverride: string | null = null;

let app: Awaited<ReturnType<typeof freshAppWithDb>>["app"];
let db: Awaited<ReturnType<typeof freshAppWithDb>>["db"];
let closeDb: Awaited<ReturnType<typeof freshAppWithDb>>["close"];

async function startGoogleStub() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  googleKey = privateKey;
  const publicJwk = { ...(await exportJWK(publicKey)), kid: "google-test", alg: "RS256", use: "sig" };

  stub = http.createServer((req, res) => {
    if (req.url === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (req.url === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const form = new URLSearchParams(body);
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!expected || challenge !== expected.codeChallenge || form.get("client_secret") !== "test-secret") {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const idToken = await new SignJWT({
          email: "homer@example.com",
          email_verified: true,
          name: "Homer Test",
          nonce: nonceOverride ?? expected.nonce,
        })
          .setProtectedHeader({ alg: "RS256", kid: "google-test" })
          .setIssuer("https://accounts.google.com")
          .setAudience(CLIENT_ID)
          .setSubject("google-sub-123")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(googleKey);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id_token: idToken }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
}

/** Runs GET /auth/login and returns the state cookie plus the parsed Google redirect. */
async function startLogin() {
  const res = await request(app).get("/auth/login");
  const location = new URL(res.headers.location ?? "");
  const stateCookie = getCookie(res.headers["set-cookie"], "tn_oauth_state");
  expected = {
    codeChallenge: location.searchParams.get("code_challenge") ?? "",
    nonce: location.searchParams.get("nonce") ?? "",
  };
  return { res, location, stateCookie, state: location.searchParams.get("state") ?? "" };
}

async function completeLogin() {
  const { state, stateCookie } = await startLogin();
  const callback = await request(app)
    .get(`/auth/callback?code=test-code&state=${encodeURIComponent(state)}`)
    .set("Cookie", `tn_oauth_state=${stateCookie}`);
  return { callback, session: getCookie(callback.headers["set-cookie"], "tn_session") };
}

describe("Google login flow (F7)", () => {
  beforeAll(async () => {
    const stubUrl = await startGoogleStub();
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_TOKEN_URL = `${stubUrl}/token`;
    process.env.GOOGLE_JWKS_URI = `${stubUrl}/jwks`;
    process.env.APP_BASE_URL = APP;
    process.env.CORS_ALLOWED_ORIGINS = APP;
    await useTestSigningKey();
  });

  beforeEach(async () => {
    ({ app, db, close: closeDb } = await freshAppWithDb());
    expected = null;
    nonceOverride = null;
  });

  afterEach(async () => {
    await closeDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => stub.close(resolve));
  });

  it("redirects to Google with PKCE (S256), state and nonce, and binds state to a cookie", async () => {
    const { res, location, stateCookie, state } = await startLogin();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(state).toBeTruthy();
    expect(stateCookie).toBe(state);
    const cookieHeader = ([] as string[]).concat(res.headers["set-cookie"] ?? []).join(";");
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Lax/i);
  });

  it("completes login: session cookie -> access token -> authorized API call, all audited", async () => {
    const { callback, session } = await completeLogin();
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`${APP}/`);
    expect(session).toBeTruthy();

    const tokenRes = await request(app)
      .post("/auth/token")
      .set("Origin", APP)
      .set("Cookie", `tn_session=${session}`);
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers["cache-control"]).toBe("no-store");
    // Hand-predicted: first login creates user 1 as a viewer with read+play scopes.
    expect(tokenRes.body.user).toEqual({ id: 1, email: "homer@example.com", displayName: "Homer Test", role: "viewer" });
    expect(tokenRes.body.scope).toBe("trivia:read trivia:play");

    const bearer = `Bearer ${tokenRes.body.accessToken as string}`;
    // The user row now exists, so this foreign-key insert succeeds.
    const started = await request(app).post("/api/sessions").set("Authorization", bearer);
    expect(started.status).toBe(201);
    expect(started.headers.location).toBe(`/api/sessions/${started.body.id}`);
    // A viewer token may not write questions.
    const write = await request(app).post("/api/questions").set("Authorization", bearer).send({});
    expect(write.status).toBe(403);

    const { rows: audit } = await db.execute<{ actor: number; action: string }>(
      sql`SELECT actor_user_id AS actor, action FROM audit_log ORDER BY id`,
    );
    expect(audit).toEqual([
      { actor: 1, action: "user.create" },
      { actor: 1, action: "auth.login" },
      { actor: 1, action: "session.start" },
    ]);
  });

  it("logout revokes the session so it can no longer mint tokens", async () => {
    const { session } = await completeLogin();
    const logout = await request(app).post("/auth/logout").set("Origin", APP).set("Cookie", `tn_session=${session}`);
    expect(logout.status).toBe(204);
    const after = await request(app).post("/auth/token").set("Origin", APP).set("Cookie", `tn_session=${session}`);
    expect(after.status).toBe(401);
  });

  it("rejects a callback whose state does not match the browser's cookie", async () => {
    const { state } = await startLogin();
    const res = await request(app)
      .get(`/auth/callback?code=test-code&state=${encodeURIComponent(state)}`)
      .set("Cookie", "tn_oauth_state=someone-elses-state");
    expect(res.headers.location).toBe(`${APP}/?login=failed`);
    expect(getCookie(res.headers["set-cookie"], "tn_session")).toBeUndefined();
  });

  it("rejects a replayed callback (state is single-use)", async () => {
    const { state, stateCookie } = await startLogin();
    const url = `/auth/callback?code=test-code&state=${encodeURIComponent(state)}`;
    const first = await request(app).get(url).set("Cookie", `tn_oauth_state=${stateCookie}`);
    expect(first.headers.location).toBe(`${APP}/`);
    const replay = await request(app).get(url).set("Cookie", `tn_oauth_state=${stateCookie}`);
    expect(replay.headers.location).toBe(`${APP}/?login=failed`);
  });

  it("rejects an ID token whose nonce does not match this login", async () => {
    nonceOverride = "nonce-from-a-different-login";
    const { callback, session } = await completeLogin();
    expect(callback.headers.location).toBe(`${APP}/?login=failed`);
    expect(session).toBeUndefined();
  });

  it("fails the login when Google rejects the PKCE verifier", async () => {
    const { state, stateCookie } = await startLogin();
    expected = { codeChallenge: "a-challenge-the-backend-never-sent", nonce: expected?.nonce ?? "" };
    const res = await request(app)
      .get(`/auth/callback?code=test-code&state=${encodeURIComponent(state)}`)
      .set("Cookie", `tn_oauth_state=${stateCookie}`);
    expect(res.headers.location).toBe(`${APP}/?login=failed`);
  });

  it("refuses to mint tokens for a request from a non-allowlisted origin (CSRF, 403)", async () => {
    const { session } = await completeLogin();
    const res = await request(app)
      .post("/auth/token")
      .set("Origin", "https://evil.example")
      .set("Cookie", `tn_session=${session}`);
    expect(res.status).toBe(403);
  });

  it("returns 401 from /auth/token when not signed in", async () => {
    const res = await request(app).post("/auth/token").set("Origin", APP);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  // Nested: shares the fake-Google server and the fresh app/db from the hooks above.
  describe("bootstrap operator list (F9, BOOTSTRAP_OPERATOR_EMAILS)", () => {
    afterEach(() => {
      delete process.env.BOOTSTRAP_OPERATOR_EMAILS;
    });

    const signInAndGetUser = async () => {
      const { session } = await completeLogin();
      const res = await request(app).post("/auth/token").set("Origin", APP).set("Cookie", `tn_session=${session}`);
      return res.body as { user: { role: string }; scope: string };
    };
    const roleChanges = async () =>
      (await db.execute<{ actor: number | null; after: { role: string; reason: string } }>(
        sql`SELECT actor_user_id AS actor, after FROM audit_log WHERE action = 'user.role_change' ORDER BY id`,
      )).rows;

    it("promotes a listed, Google-verified email to operator on sign-in (case-insensitive) and audits it", async () => {
      process.env.BOOTSTRAP_OPERATOR_EMAILS = " someone@else.example , HOMER@example.com ";
      const body = await signInAndGetUser();
      expect(body.user.role).toBe("operator");
      expect(body.scope).toBe("trivia:read trivia:play questions:write");
      expect(await roleChanges()).toEqual([{ actor: null, after: { role: "operator", reason: "BOOTSTRAP_OPERATOR_EMAILS" } }]);
    });

    it("leaves unlisted users as viewers", async () => {
      process.env.BOOTSTRAP_OPERATOR_EMAILS = "someone@else.example";
      expect((await signInAndGetUser()).user.role).toBe("viewer");
      expect(await roleChanges()).toEqual([]);
    });

    it("promotes an existing viewer at their next sign-in, once; removing the email does not demote", async () => {
      expect((await signInAndGetUser()).user.role).toBe("viewer"); // first sign-in, not listed
      process.env.BOOTSTRAP_OPERATOR_EMAILS = "homer@example.com";
      expect((await signInAndGetUser()).user.role).toBe("operator");
      expect((await signInAndGetUser()).user.role).toBe("operator"); // no second promotion
      expect(await roleChanges()).toHaveLength(1);
      delete process.env.BOOTSTRAP_OPERATOR_EMAILS;
      expect((await signInAndGetUser()).user.role).toBe("operator"); // demotion stays a deliberate act
    });
  });
});

import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { decodeJwt } from "jose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshAppWithDb, TEST_ISSUER, useTestSigningKey } from "./helpers.js";

/**
 * F12 phase 1: the OAuth 2.1 authorization server for MCP clients (spec 2026-07-28).
 * The client's metadata document (CIMD) is served by a stubbed fetch; Google is not
 * involved because a TriviaNerd session is created directly.
 * Expected outcomes were predicted by hand before running.
 */

const CLIENT_ID = "https://client.example.test/oauth/metadata.json";
const REDIRECT = "https://client.example.test/callback";
const MCP_RESOURCE = `${TEST_ISSUER}/mcp`;
const ORIGIN = new URL(TEST_ISSUER).origin;

type Fresh = Awaited<ReturnType<typeof freshAppWithDb>>;
let app: Fresh["app"];
let db: Fresh["db"];
let close: Fresh["close"];
let schema: typeof import("../src/db/schema.js");
const realFetch = global.fetch;
let clientDocument: Record<string, unknown>;

const verifier = () => randomBytes(48).toString("base64url");
const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");

beforeEach(async () => {
  process.env.CIMD_ALLOW_NON_PUBLIC_HOSTS = "true";
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  await useTestSigningKey();
  ({ app, db, close } = await freshAppWithDb());
  schema = await import("../src/db/schema.js");
  clientDocument = { client_id: CLIENT_ID, client_name: "Test MCP Client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === CLIENT_ID) {
      return new Response(JSON.stringify(clientDocument), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    return realFetch(input);
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  global.fetch = realFetch;
  delete process.env.CIMD_ALLOW_NON_PUBLIC_HOSTS;
  await close();
});

async function signedIn(role: "viewer" | "operator" = "viewer") {
  const [user] = await db
    .insert(schema.users)
    .values({ oidcSubject: `sub-${Math.random()}`, email: `${role}@example.com`, displayName: `Test ${role}`, role })
    .returning();
  const { createSession } = await import("../src/auth/sessions.js");
  const { token } = await createSession(user!.id);
  return { userId: user!.id, cookie: `tn_session=${token}` };
}

function authorizePath(overrides: Record<string, string | undefined> = {}, pkceVerifier = verifier()) {
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: challengeOf(pkceVerifier),
    code_challenge_method: "S256",
    state: "xyz-state",
    resource: MCP_RESOURCE,
    ...overrides,
  };
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
  return `/auth/oauth/authorize?${qs}`;
}

/** Runs authorize + consent (Allow) and returns the authorization code. */
async function obtainCode(cookie: string, pkceVerifier: string, scope?: string) {
  const page = await request(app).get(authorizePath({ scope }, pkceVerifier)).set("Cookie", cookie);
  expect(page.status).toBe(200);
  const requestToken = /name="request" value="([^"]+)"/.exec(page.text)![1]!;
  const decision = await request(app)
    .post("/auth/oauth/authorize")
    .set("Cookie", cookie)
    .set("Origin", ORIGIN)
    .type("form")
    .send({ request: requestToken, decision: "allow" });
  expect(decision.status).toBe(302);
  const location = new URL(decision.headers.location!);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("xyz-state");
  expect(location.searchParams.get("iss")).toBe(TEST_ISSUER);
  return location.searchParams.get("code")!;
}

function exchange(code: string, pkceVerifier: string, overrides: Record<string, string | undefined> = {}) {
  const body = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: pkceVerifier, resource: MCP_RESOURCE, ...overrides };
  return request(app)
    .post("/auth/oauth/token")
    .type("form")
    .send(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
}

function refresh(refreshToken: string, extra: Record<string, string> = {}) {
  return request(app).post("/auth/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID, ...extra });
}

describe("discovery metadata", () => {
  it("serves RFC 9728 resource metadata at both well-known paths, CORS * without credentials", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await request(app).get(path).set("Origin", "https://inspector.example");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        resource: MCP_RESOURCE,
        authorization_servers: [TEST_ISSUER],
        scopes_supported: ["trivia:read", "trivia:play"],
        bearer_methods_supported: ["header"],
        resource_name: "TriviaNerd",
      });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    }
  });

  it("serves RFC 8414 authorization-server metadata advertising S256 and CIMD", async () => {
    const res = await request(app).get("/.well-known/oauth-authorization-server");
    expect(res.body).toMatchObject({
      issuer: TEST_ISSUER,
      authorization_endpoint: `${TEST_ISSUER}/auth/oauth/authorize`,
      token_endpoint: `${TEST_ISSUER}/auth/oauth/token`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["trivia:read", "trivia:play", "questions:write"],
    });
  });

  it("answers a preflight from any origin on the token endpoint, but keeps the allowlist elsewhere", async () => {
    const pre = await request(app).options("/auth/oauth/token").set("Origin", "https://inspector.example");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
    const cookieEndpoint = await request(app).options("/auth/token").set("Origin", "https://inspector.example");
    expect(cookieEndpoint.status).toBe(403);
  });
});

describe("authorize: requests that must not redirect", () => {
  it("rejects a non-https client_id, a mismatched document and an unregistered redirect URI with a 400 page", async () => {
    const http = await request(app).get(authorizePath({ client_id: "http://client.example.test/oauth/metadata.json" }));
    expect(http.status).toBe(400);
    expect(http.headers.location).toBeUndefined();

    clientDocument.client_id = "https://someone-else.example/metadata.json";
    const mismatch = await request(app).get(authorizePath());
    expect(mismatch.status).toBe(400);
    expect(mismatch.text).toContain("does not match");

    clientDocument.client_id = CLIENT_ID;
    const badRedirect = await request(app).get(authorizePath({ redirect_uri: "https://attacker.example/cb" }));
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.headers.location).toBeUndefined(); // never an open redirect
  });
});

describe("authorize: errors returned to the client", () => {
  it.each([
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: undefined }, "invalid_request"],
    [{ resource: "https://other-server.example/mcp" }, "invalid_target"],
    [{ resource: undefined }, "invalid_target"],
    [{ scope: "trivia:read admin:all" }, "invalid_scope"],
    [{ response_type: "token" }, "unsupported_response_type"],
  ])("%j → %s, with state and iss", async (overrides, error) => {
    const res = await request(app).get(authorizePath(overrides));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe(error);
    expect(loc.searchParams.get("state")).toBe("xyz-state");
    expect(loc.searchParams.get("iss")).toBe(TEST_ISSUER);
  });
});

describe("authorize: sign-in and consent", () => {
  it("sends a signed-out user to Google login and resumes the request afterwards", async () => {
    const path = authorizePath();
    const res = await request(app).get(path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/auth/login?return_to=${encodeURIComponent(path)}`);

    await request(app).get(res.headers.location!); // starts the Google login
    const { rows } = await db.execute<{ return_to: string | null }>(sql`SELECT return_to FROM oauth_login_states`);
    expect(rows.map((r) => r.return_to)).toEqual([path]);
  });

  it("never stores a return_to that is not this server's authorize endpoint", async () => {
    await request(app).get(`/auth/login?return_to=${encodeURIComponent("https://evil.example/")}`);
    await request(app).get(`/auth/login?return_to=${encodeURIComponent("//evil.example/auth/oauth/authorize?")}`);
    const { rows } = await db.execute<{ return_to: string | null }>(sql`SELECT return_to FROM oauth_login_states`);
    expect(rows.map((r) => r.return_to)).toEqual([null, null]);
  });

  it("shows a consent screen: escaped client name, redirect host, role-capped scopes, anti-framing", async () => {
    clientDocument.client_name = "<b>Sneaky</b> Client";
    const { cookie } = await signedIn("viewer");
    const res = await request(app).get(authorizePath({ scope: "trivia:read questions:write" })).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain("&lt;b&gt;Sneaky&lt;/b&gt; Client");
    expect(res.text).not.toContain("<b>Sneaky</b>");
    expect(res.text).toContain("client.example.test");
    expect(res.text).toMatch(/questions:write<\/code>, not available for your role/);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["content-security-policy"]).toContain("form-action 'self' https://client.example.test");
  });

  it("Deny redirects with access_denied; a foreign Origin or a tampered request is refused", async () => {
    const { cookie } = await signedIn();
    const page = await request(app).get(authorizePath()).set("Cookie", cookie);
    const token = /name="request" value="([^"]+)"/.exec(page.text)![1]!;

    const deny = await request(app).post("/auth/oauth/authorize").set("Cookie", cookie).set("Origin", ORIGIN).type("form").send({ request: token, decision: "deny" });
    expect(new URL(deny.headers.location!).searchParams.get("error")).toBe("access_denied");

    const csrf = await request(app).post("/auth/oauth/authorize").set("Cookie", cookie).set("Origin", "https://evil.example").type("form").send({ request: token, decision: "allow" });
    expect(csrf.status).toBe(403);

    const tampered = await request(app).post("/auth/oauth/authorize").set("Cookie", cookie).set("Origin", ORIGIN).type("form").send({ request: `${token}x`, decision: "allow" });
    expect(tampered.status).toBe(400);
  });

  it("works with real browser behaviour: Origin null + Sec-Fetch-Site same-origin is accepted, cross-site is not", async () => {
    // Regression: staging's consent form failed because the page was served with
    // Referrer-Policy: no-referrer, making the browser send `Origin: null`.
    const { cookie } = await signedIn();
    const post = async (headers: Record<string, string>) => {
      const page = await request(app).get(authorizePath()).set("Cookie", cookie);
      expect(page.headers["referrer-policy"]).toBe("same-origin");
      const token = /name="request" value="([^"]+)"/.exec(page.text)![1]!;
      return request(app).post("/auth/oauth/authorize").set("Cookie", cookie).set(headers).type("form").send({ request: token, decision: "allow" });
    };

    const browserLike = await post({ Origin: "null", "Sec-Fetch-Site": "same-origin" });
    expect(browserLike.status).toBe(302);
    expect(new URL(browserLike.headers.location!).searchParams.get("code")).toBeTruthy();

    expect((await post({ Origin: "null", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post({ "Sec-Fetch-Site": "same-site" })).status).toBe(403); // a sibling subdomain is not us
    expect((await post({})).status).toBe(403); // no evidence of origin at all
  });

  it("refuses a consent request signed for a different user", async () => {
    const alice = await signedIn();
    const bob = await signedIn();
    const page = await request(app).get(authorizePath()).set("Cookie", alice.cookie);
    const aliceToken = /name="request" value="([^"]+)"/.exec(page.text)![1]!;
    const res = await request(app).post("/auth/oauth/authorize").set("Cookie", bob.cookie).set("Origin", ORIGIN).type("form").send({ request: aliceToken, decision: "allow" });
    expect(res.status).toBe(400);
  });
});

describe("token endpoint", () => {
  it("issues an MCP-audience token that the web API refuses, and audits consent + issuance", async () => {
    const { cookie, userId } = await signedIn();
    const v = verifier();
    const code = await obtainCode(cookie, v);
    const res = await exchange(code, v);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "trivia:read trivia:play" });
    const claims = decodeJwt(res.body.access_token);
    expect(claims).toMatchObject({ aud: MCP_RESOURCE, sub: String(userId), client_id: CLIENT_ID, scope: "trivia:read trivia:play" });

    const { verifyMcpAccessToken, verifyAccessToken } = await import("../src/auth/jwt.js");
    await expect(verifyMcpAccessToken(res.body.access_token)).resolves.toMatchObject({ sub: String(userId) });
    await expect(verifyAccessToken(res.body.access_token)).rejects.toThrow(); // wrong audience for the web API
    const webCall = await request(app).post("/api/sessions").set("Authorization", `Bearer ${res.body.access_token}`);
    expect(webCall.status).toBe(401);

    const { issueAccessToken } = await import("../src/auth/tokens.js");
    const webToken = (await issueAccessToken({ id: userId, role: "viewer" })).accessToken;
    await expect(verifyMcpAccessToken(webToken)).rejects.toThrow(); // and the reverse

    const { rows } = await db.execute<{ action: string }>(sql`SELECT action FROM audit_log WHERE action LIKE 'oauth.%' ORDER BY id`);
    expect(rows.map((r) => r.action)).toEqual(["oauth.consent_granted", "oauth.token_issued"]);
  });

  it("caps scopes to the role: a viewer cannot obtain questions:write, an operator can", async () => {
    const viewer = await signedIn("viewer");
    const v1 = verifier();
    const t1 = await exchange(await obtainCode(viewer.cookie, v1, "trivia:read questions:write"), v1);
    expect(t1.body.scope).toBe("trivia:read");

    const operator = await signedIn("operator");
    const v2 = verifier();
    const t2 = await exchange(await obtainCode(operator.cookie, v2, "trivia:read questions:write"), v2);
    expect(t2.body.scope).toBe("trivia:read questions:write");
  });

  it.each([
    ["a wrong PKCE verifier", { code_verifier: randomBytes(48).toString("base64url") }, "invalid_grant"],
    ["a different redirect_uri", { redirect_uri: "https://client.example.test/other" }, "invalid_grant"],
    ["a different client_id", { client_id: "https://other.example.test/meta.json" }, "invalid_grant"],
    ["no resource", { resource: undefined }, "invalid_target"],
    ["another resource", { resource: "https://other-server.example/mcp" }, "invalid_target"],
  ])("rejects %s", async (_label, overrides, error) => {
    const { cookie } = await signedIn();
    const v = verifier();
    const res = await exchange(await obtainCode(cookie, v), v, overrides);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });

  it("rejects an expired code", async () => {
    const { cookie } = await signedIn();
    const v = verifier();
    const code = await obtainCode(cookie, v);
    await db.execute(sql`UPDATE oauth_authorization_codes SET expires_at = now() - interval '1 second'`);
    expect((await exchange(code, v)).body.error).toBe("invalid_grant");
  });

  it("a reused code is refused AND revokes the tokens from its first redemption", async () => {
    const { cookie } = await signedIn();
    const v = verifier();
    const code = await obtainCode(cookie, v);
    const first = await exchange(code, v);
    expect(first.status).toBe(200);

    const replay = await exchange(code, v);
    expect(replay.body).toMatchObject({ error: "invalid_grant" });
    expect((await refresh(first.body.refresh_token)).body.error).toBe("invalid_grant");
  });

  it("rotates refresh tokens; replaying an old one revokes the whole family", async () => {
    const { cookie } = await signedIn();
    const v = verifier();
    const t0 = await exchange(await obtainCode(cookie, v), v);

    const t1 = await refresh(t0.body.refresh_token);
    expect(t1.status).toBe(200);
    expect(t1.body.refresh_token).not.toBe(t0.body.refresh_token);
    expect(decodeJwt(t1.body.access_token).aud).toBe(MCP_RESOURCE);

    expect((await refresh(t0.body.refresh_token)).body.error).toBe("invalid_grant"); // reuse detected
    expect((await refresh(t1.body.refresh_token)).body.error).toBe("invalid_grant"); // family revoked

    const { rows } = await db.execute<{ action: string }>(sql`SELECT action FROM audit_log WHERE action = 'oauth.refresh_reuse_detected'`);
    expect(rows).toHaveLength(1);
  });

  it("a refresh may narrow scopes but never add them", async () => {
    const { cookie } = await signedIn();
    const v = verifier();
    const t0 = await exchange(await obtainCode(cookie, v, "trivia:read"), v);
    expect((await refresh(t0.body.refresh_token, { scope: "trivia:read trivia:play" })).body.error).toBe("invalid_scope");
  });

  it("rejects unknown grant types", async () => {
    const res = await request(app).post("/auth/oauth/token").type("form").send({ grant_type: "password", client_id: CLIENT_ID });
    expect(res.body.error).toBe("unsupported_grant_type");
  });
});

describe("published client document for MCP Inspector", () => {
  it("is a valid CIMD document for this environment, redirecting only to Inspector's local callback", async () => {
    const res = await request(app).get("/oauth/clients/mcp-inspector.json");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      client_id: `${TEST_ISSUER}/oauth/clients/mcp-inspector.json`,
      client_name: "MCP Inspector (local)",
      redirect_uris: ["http://localhost:6274/oauth/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  it("passes our own CIMD validation and gets a consent screen with the localhost warning", async () => {
    // Deployed, the document lives at https://<api host>/oauth/clients/mcp-inspector.json;
    // here the same body is served at an https test URL with client_id set to match.
    const docUrl = "https://api.example.test/oauth/clients/mcp-inspector.json";
    const body = (await request(app).get("/oauth/clients/mcp-inspector.json")).body as Record<string, unknown>;
    const inspectorDoc = { ...body, client_id: docUrl };
    const previous = global.fetch;
    global.fetch = vi.fn(async (input: string | URL | Request) =>
      String(input instanceof Request ? input.url : input) === docUrl
        ? new Response(JSON.stringify(inspectorDoc), { status: 200, headers: { "Content-Type": "application/json" } })
        : previous(input),
    ) as unknown as typeof fetch;

    const { cookie } = await signedIn();
    const page = await request(app)
      .get(authorizePath({ client_id: docUrl, redirect_uri: "http://localhost:6274/oauth/callback" }))
      .set("Cookie", cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain("MCP Inspector (local)");
    expect(page.text).toContain("Only allow it if you started it yourself"); // localhost warning
  });
});

describe("CIMD SSRF guard", () => {
  it.each([
    ["127.0.0.1", true], ["10.1.2.3", true], ["172.20.0.1", true], ["192.168.1.1", true],
    ["169.254.169.254", true], ["100.64.0.1", true], ["::1", true], ["fd00::1", true],
    ["fe80::1", true], ["::ffff:10.0.0.1", true], ["8.8.8.8", false], ["2606:4700::1111", false],
  ])("isNonPublicAddress(%s) → %s", async (ip, expected) => {
    const { isNonPublicAddress } = await import("../src/oauth/clientMetadata.js");
    expect(isNonPublicAddress(ip)).toBe(expected);
  });

  it("refuses a client_id whose host resolves to a private address", async () => {
    delete process.env.CIMD_ALLOW_NON_PUBLIC_HOSTS;
    const { getClientMetadata } = await import("../src/oauth/clientMetadata.js");
    await expect(getClientMetadata("https://localhost/oauth/metadata.json")).rejects.toThrow(/non-public address/);
  });
});

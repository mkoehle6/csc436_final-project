import { createHash } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { jwtVerify, SignJWT } from "jose";
import { authConfig, SESSION_COOKIE } from "../auth/config.js";
import { getSigningKey } from "../auth/keys.js";
import { MCP_BASIC_SCOPES, MCP_SCOPES, scopesForRole } from "../auth/scopes.js";
import { findActiveSession } from "../auth/sessions.js";
import { issueMcpAccessToken } from "../auth/tokens.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { limits } from "../middleware/rateLimit.js";
import { ClientMetadataError, getClientMetadata } from "../oauth/clientMetadata.js";
import { renderConsent, renderError } from "../oauth/pages.js";
import {
  consumeAuthorizationCode,
  createAuthorizationCode,
  issueRefreshToken,
  rotateRefreshToken,
} from "../oauth/store.js";
import { eq } from "drizzle-orm";

/**
 * OAuth 2.1 authorization server for MCP clients (F12), per the MCP
 * authorization spec 2026-07-28:
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 resource metadata
 *   GET  /.well-known/oauth-authorization-server      RFC 8414 server metadata
 *   GET  /auth/oauth/authorize    validate request → (Google login) → consent screen
 *   POST /auth/oauth/authorize    consent decision → redirect with code (+state, iss)
 *   POST /auth/oauth/token        authorization_code (PKCE) and refresh_token grants
 *
 * Clients are identified by Client ID Metadata Documents (oauth/clientMetadata.ts).
 * People still sign in with Google; this server issues MCP-only tokens whose
 * audience is the MCP endpoint, never usable on the web API.
 */
export const oauthRouter = Router();

const authorizeLimiter = limits.login();
const tokenLimiter = limits.token();
const formBody = express.urlencoded({ extended: false, limit: "10kb" });

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CONSENT_TYP = "oauth-consent+jwt";

const resourceMetadata = () => ({
  resource: authConfig.mcpResource,
  authorization_servers: [authConfig.issuer],
  scopes_supported: MCP_BASIC_SCOPES,
  bearer_methods_supported: ["header"],
  resource_name: "TriviaNerd",
});

oauthRouter.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json(resourceMetadata());
});

/**
 * A Client ID Metadata Document for MCP Inspector (the official MCP debugging
 * tool). Inspector runs on the developer's machine, so it cannot publish its own
 * document; we publish one for it. Its client_id is this URL on the current
 * environment, and it may only redirect to Inspector's local callback, so the
 * consent screen shows the localhost warning. Enter this URL in Inspector under
 * "Use Client ID Metadata Document".
 */
export const INSPECTOR_CLIENT_PATH = "/oauth/clients/mcp-inspector.json";
export const INSPECTOR_REDIRECT_URIS = ["http://localhost:6274/oauth/callback"];

oauthRouter.get(INSPECTOR_CLIENT_PATH, (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    client_id: `${authConfig.issuer}${INSPECTOR_CLIENT_PATH}`,
    client_name: "MCP Inspector (local)",
    client_uri: "https://github.com/modelcontextprotocol/inspector",
    redirect_uris: INSPECTOR_REDIRECT_URIS,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
  });
});

oauthRouter.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const issuer = authConfig.issuer;
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/auth/oauth/authorize`,
    token_endpoint: `${issuer}/auth/oauth/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: MCP_SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
});

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const splitScope = (s: string | undefined) => (s ?? "").split(" ").filter(Boolean);

function redirectWith(res: Response, redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  url.searchParams.set("iss", authConfig.issuer); // RFC 9207 mix-up defence
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, url.toString());
}

/**
 * Was this POST submitted by a page on our own origin? Primary signal: the Origin
 * header. Some browsers send `Origin: null` for form posts (e.g. under a
 * no-referrer policy), so when Origin is absent or "null" we accept the
 * browser-set Sec-Fetch-Site: same-origin, which a web page cannot forge.
 * Anything else, including any cross-site request, is refused.
 */
function isSameOriginFormPost(req: Request): boolean {
  const origin = req.header("origin");
  if (origin && origin !== "null") return origin === new URL(authConfig.issuer).origin;
  return req.header("sec-fetch-site") === "same-origin";
}

async function currentUser(req: Request) {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || !token) return null;
  return (await findActiveSession(token))?.user ?? null;
}

oauthRouter.get("/auth/oauth/authorize", authorizeLimiter, async (req, res, next) => {
  try {
    const clientId = str(req.query.client_id);
    const redirectUri = str(req.query.redirect_uri);
    if (!clientId || !redirectUri) {
      renderError(res, 400, "The request is missing client_id or redirect_uri.");
      return;
    }

    // Until the client and its redirect URI are verified, errors must NOT redirect
    // (that would make this endpoint an open redirector).
    let client;
    try {
      client = await getClientMetadata(clientId);
    } catch (err) {
      if (err instanceof ClientMetadataError) {
        req.log.warn({ clientId, reason: err.message }, "oauth: client metadata rejected");
        renderError(res, 400, `The app could not be verified: ${err.message}.`);
        return;
      }
      throw err;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      renderError(res, 400, "The redirect address is not registered for this app.");
      return;
    }

    const state = str(req.query.state);
    const fail = (error: string, description: string) =>
      redirectWith(res, redirectUri, { error, error_description: description, state });

    if (str(req.query.response_type) !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    const codeChallenge = str(req.query.code_challenge);
    if (str(req.query.code_challenge_method) !== "S256" || !codeChallenge || !PKCE_CHALLENGE.test(codeChallenge)) {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    if (str(req.query.resource) !== authConfig.mcpResource) {
      return fail("invalid_target", `resource must be ${authConfig.mcpResource}`);
    }
    const requested = splitScope(str(req.query.scope));
    const scopes = requested.length > 0 ? requested : [...MCP_BASIC_SCOPES];
    if (!scopes.every((s) => (MCP_SCOPES as readonly string[]).includes(s))) {
      return fail("invalid_scope", `Supported scopes: ${MCP_SCOPES.join(" ")}`);
    }

    const user = await currentUser(req);
    if (!user) {
      // Sign in with Google first, then come straight back to this request.
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, `/auth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
      return;
    }

    const allowed = scopesForRole(user.role);
    const granted = scopes.filter((s) => allowed.includes(s));
    const denied = scopes.filter((s) => !allowed.includes(s));
    if (granted.length === 0) return fail("access_denied", "None of the requested permissions are available to this account");

    // The consent form carries the validated request as a signed, short-lived
    // token bound to this user, so nothing can be altered between screen and POST.
    const key = await getSigningKey();
    const requestToken = await new SignJWT({
      client_id: clientId,
      client_name: client.clientName,
      redirect_uri: redirectUri,
      scope: granted.join(" "),
      state: state ?? null,
      code_challenge: codeChallenge,
      resource: authConfig.mcpResource,
    })
      .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: CONSENT_TYP })
      .setIssuer(authConfig.issuer)
      .setAudience(authConfig.issuer)
      .setSubject(String(user.id))
      .setIssuedAt()
      .setExpirationTime(`${authConfig.mcp.consentRequestTtlSeconds}s`)
      .sign(key.privateKey);

    renderConsent(res, {
      clientName: client.clientName,
      clientIdHost: new URL(clientId).host,
      redirectUri,
      userLabel: user.displayName ?? user.email,
      grantedScopes: granted,
      deniedScopes: denied,
      requestToken,
    });
  } catch (err) {
    next(err);
  }
});

oauthRouter.post("/auth/oauth/authorize", authorizeLimiter, formBody, async (req, res, next) => {
  try {
    // CSRF: the session cookie is SameSite=Lax (not sent on cross-site POSTs),
    // the form must come from our own origin, and the request token is bound to the user.
    if (!isSameOriginFormPost(req)) {
      renderError(res, 403, "This form must be submitted from TriviaNerd itself.");
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      renderError(res, 401, "Your TriviaNerd sign-in has expired. Start the connection again from your app.");
      return;
    }

    const body = req.body as Record<string, unknown>;
    let request;
    try {
      const { verificationKeys } = await getSigningKey();
      ({ payload: request } = await jwtVerify(str(body.request) ?? "", verificationKeys, {
        issuer: authConfig.issuer,
        audience: authConfig.issuer,
        typ: CONSENT_TYP,
        algorithms: ["ES256"],
        subject: String(user.id),
      }));
    } catch {
      renderError(res, 400, "This consent request is invalid or has expired. Start the connection again from your app.");
      return;
    }

    const clientId = String(request.client_id);
    const redirectUri = String(request.redirect_uri);
    const state = typeof request.state === "string" ? request.state : undefined;
    const scope = String(request.scope);

    if (str(body.decision) !== "allow") {
      await recordAudit({
        actorUserId: user.id,
        action: "oauth.consent_denied",
        entityType: "oauth_client",
        before: null,
        after: { clientId, scope },
      });
      return redirectWith(res, redirectUri, { error: "access_denied", error_description: "The user denied access", state });
    }

    const code = await createAuthorizationCode({
      clientId,
      redirectUri,
      userId: user.id,
      scope,
      codeChallenge: String(request.code_challenge),
      resource: String(request.resource),
    });
    await recordAudit({
      actorUserId: user.id,
      action: "oauth.consent_granted",
      entityType: "oauth_client",
      before: null,
      after: { clientId, clientName: request.client_name, scope },
    });
    redirectWith(res, redirectUri, { code, state });
  } catch (err) {
    next(err);
  }
});

/** OAuth error response for the token endpoint (RFC 6749 §5.2). */
function tokenError(res: Response, error: string, description: string, status = 400) {
  res.status(status).json({ error, error_description: description });
}

const pkceMatches = (verifier: string, challenge: string) =>
  createHash("sha256").update(verifier).digest("base64url") === challenge;

oauthRouter.post("/auth/oauth/token", tokenLimiter, formBody, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = str(body.grant_type);
    const clientId = str(body.client_id);
    const resource = str(body.resource);
    if (!clientId) return tokenError(res, "invalid_request", "client_id is required");
    if (resource !== undefined && resource !== authConfig.mcpResource) {
      return tokenError(res, "invalid_target", `resource must be ${authConfig.mcpResource}`);
    }

    let userId: number;
    let scope: string;
    let familyId: number;
    let refreshToken: string | undefined;

    if (grantType === "authorization_code") {
      const code = str(body.code);
      const redirectUri = str(body.redirect_uri);
      const verifier = str(body.code_verifier);
      if (!code || !redirectUri || !verifier) {
        return tokenError(res, "invalid_request", "code, redirect_uri and code_verifier are required");
      }
      if (resource === undefined) return tokenError(res, "invalid_target", "resource is required");

      const consumed = await consumeAuthorizationCode(code);
      if (!consumed.ok) {
        if (consumed.reason === "reused") {
          await recordAudit({ actorUserId: null, action: "oauth.code_reuse_detected", entityType: "oauth_client", after: { clientId } });
        }
        return tokenError(res, "invalid_grant", `Authorization code is ${consumed.reason === "reused" ? "already used" : consumed.reason}`);
      }
      const { grant } = consumed;
      if (grant.clientId !== clientId || grant.redirectUri !== redirectUri) {
        return tokenError(res, "invalid_grant", "client_id or redirect_uri does not match the authorization request");
      }
      if (grant.resource !== resource) return tokenError(res, "invalid_target", "resource does not match the authorization request");
      if (!PKCE_VERIFIER.test(verifier) || !pkceMatches(verifier, grant.codeChallenge)) {
        return tokenError(res, "invalid_grant", "PKCE verification failed");
      }
      userId = grant.userId;
      scope = grant.scope;
      familyId = consumed.id;
    } else if (grantType === "refresh_token") {
      const presented = str(body.refresh_token);
      if (!presented) return tokenError(res, "invalid_request", "refresh_token is required");
      const rotated = await rotateRefreshToken(presented, clientId);
      if (!rotated.ok) {
        if (rotated.reason === "reused") {
          await recordAudit({ actorUserId: null, action: "oauth.refresh_reuse_detected", entityType: "oauth_client", after: { clientId } });
        }
        return tokenError(res, "invalid_grant", `Refresh token is ${rotated.reason.replace("_", " ")}`);
      }
      const narrowed = splitScope(str(body.scope));
      const original = splitScope(rotated.grant.scope);
      if (narrowed.some((s) => !original.includes(s))) {
        return tokenError(res, "invalid_scope", "A refresh cannot add scopes");
      }
      userId = rotated.grant.userId;
      scope = narrowed.length > 0 ? narrowed.join(" ") : rotated.grant.scope;
      familyId = rotated.grant.familyId;
      refreshToken = rotated.refreshToken;
    } else {
      return tokenError(res, "unsupported_grant_type", "Use authorization_code or refresh_token");
    }

    // The role may have changed since consent: never issue more than it allows now.
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) return tokenError(res, "invalid_grant", "User no longer exists");
    const allowed = scopesForRole(user.role);
    const effectiveScope = splitScope(scope).filter((s) => allowed.includes(s)).join(" ");

    refreshToken ??= await issueRefreshToken({
      familyId,
      clientId,
      userId,
      scope: effectiveScope,
      resource: authConfig.mcpResource,
    });
    const { accessToken, expiresIn } = await issueMcpAccessToken({
      userId,
      role: user.role,
      scope: effectiveScope,
      clientId,
    });

    await recordAudit({
      actorUserId: userId,
      action: grantType === "authorization_code" ? "oauth.token_issued" : "oauth.token_refreshed",
      entityType: "oauth_client",
      after: { clientId, scope: effectiveScope },
    });
    res.status(200).json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: effectiveScope,
    });
  } catch (err) {
    next(err);
  }
});

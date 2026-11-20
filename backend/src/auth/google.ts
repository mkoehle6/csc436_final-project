import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { authConfig } from "./config.js";

/**
 * Google as the OIDC identity provider (F7): Authorization Code flow with PKCE
 * (S256), `state` against login CSRF, and `nonce` against ID-token replay.
 * Google only proves *who* the user is; access tokens for our API are issued by
 * this backend afterwards (./tokens.ts).
 */

const TOKEN_EXCHANGE_TIMEOUT_MS = 5000;

/** Thrown for any login failure; `reason` is logged, never shown to the user verbatim. */
export class LoginFlowError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizationUrl(params: { state: string; nonce: string; codeChallenge: string }) {
  const url = new URL(authConfig.google.authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: authConfig.google.clientId,
    redirect_uri: authConfig.google.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

const tokenResponseSchema = z.object({
  id_token: z.string().min(1),
});

/** Exchanges the authorization code (plus PKCE verifier) for Google's ID token. */
export async function exchangeCode(code: string, codeVerifier: string): Promise<string> {
  // Read config outside the network try/catch so a missing secret is reported as
  // a configuration error, not misreported as "could not reach Google".
  let body: URLSearchParams;
  try {
    body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: authConfig.google.clientId,
      client_secret: authConfig.google.clientSecret,
      redirect_uri: authConfig.google.redirectUri,
    });
  } catch (err) {
    throw new LoginFlowError("server_misconfigured", (err as Error).message);
  }

  let res: Response;
  try {
    res = await fetch(authConfig.google.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    throw new LoginFlowError("token_exchange_unreachable", "Could not reach Google's token endpoint");
  }
  if (!res.ok) {
    // Google's error body names the problem (e.g. invalid_grant) but never contains secrets.
    const body = await res.text().catch(() => "");
    throw new LoginFlowError("token_exchange_failed", `Google token endpoint returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new LoginFlowError("token_exchange_malformed", "Google token response had no id_token");
  }
  return parsed.data.id_token;
}

let googleJwks: { uri: string; set: ReturnType<typeof createRemoteJWKSet> } | undefined;
function getGoogleJwks() {
  const uri = authConfig.google.jwksUri;
  if (googleJwks?.uri !== uri) {
    googleJwks = { uri, set: createRemoteJWKSet(new URL(uri)) };
  }
  return googleJwks.set;
}

const idTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.literal(true),
  name: z.string().optional(),
  nonce: z.string(),
});

export interface GoogleIdentity {
  subject: string;
  email: string;
  displayName: string | null;
}

/** Validates Google's ID token: signature (Google JWKS), issuer, audience, expiry, nonce. */
export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<GoogleIdentity> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(idToken, getGoogleJwks(), {
      issuer: authConfig.google.issuers,
      audience: authConfig.google.clientId,
      algorithms: ["RS256"],
    }));
  } catch (err) {
    throw new LoginFlowError("id_token_invalid", `Google ID token failed validation: ${(err as Error).message}`);
  }
  const claims = idTokenClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw new LoginFlowError("id_token_claims", "Google ID token is missing a verified email or nonce");
  }
  if (claims.data.nonce !== expectedNonce) {
    throw new LoginFlowError("nonce_mismatch", "Google ID token nonce does not match this login");
  }
  return {
    subject: claims.data.sub,
    email: claims.data.email,
    displayName: claims.data.name ?? null,
  };
}

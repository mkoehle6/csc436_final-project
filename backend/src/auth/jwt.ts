import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Server-side OIDC access-token validation (F8): signature via JWKS, issuer,
 * audience, expiry (handled by jwtVerify), and scope (checked by callers).
 *
 * Configured for Google as the OIDC provider (F7). Swap GOOGLE_* env vars for
 * another provider's discovery values without changing the verification logic.
 */

const ISSUER = process.env.OIDC_ISSUER ?? "https://accounts.google.com";
const AUDIENCE = process.env.OIDC_AUDIENCE ?? "";
const JWKS_URI = process.env.OIDC_JWKS_URI ?? "https://www.googleapis.com/oauth2/v3/certs";

const jwks = createRemoteJWKSet(new URL(JWKS_URI));

export interface AppClaims extends JWTPayload {
  email?: string;
  scope?: string;
  role?: "viewer" | "operator";
}

export async function verifyAccessToken(token: string): Promise<AppClaims> {
  if (!AUDIENCE) {
    throw new Error("OIDC_AUDIENCE is not configured");
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return payload as AppClaims;
}

export function hasScope(claims: AppClaims, required: string): boolean {
  const scopes = (claims.scope ?? "").split(" ").filter(Boolean);
  return scopes.includes(required);
}

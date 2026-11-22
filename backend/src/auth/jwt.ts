import { jwtVerify, type JWTPayload } from "jose";
import { authConfig } from "./config.js";
import { getSigningKey } from "./keys.js";
import { isRole, type Role } from "./scopes.js";

/**
 * Server-side access-token validation (F8). Every check is explicit:
 *  - signature: ES256 against our published JWKS (rejects other keys and `alg: none`)
 *  - `typ`: must be `at+jwt`, so a Google ID token or other JWT cannot be replayed here
 *  - issuer and audience: must be this backend and this API
 *  - expiry: `exp` is required and enforced (jose also rejects `nbf` in the future)
 *  - role: must be a known role; scope is enforced per route by `requireScope`
 *
 * Tokens are issued by ./tokens.ts after a Google OIDC login (F7).
 */

export interface AppClaims extends JWTPayload {
  sub: string;
  scope?: string;
  role?: Role;
}

export async function verifyAccessToken(token: string): Promise<AppClaims> {
  return verify(token, authConfig.audience);
}

export interface McpClaims extends AppClaims {
  client_id?: string;
}

/**
 * Validates an MCP access token (F12): same checks as the web-app token, but the
 * audience must be the MCP server's canonical URI. Web-app tokens fail here and
 * MCP tokens fail verifyAccessToken: no token is accepted outside its audience.
 */
export async function verifyMcpAccessToken(token: string): Promise<McpClaims> {
  return verify(token, authConfig.mcpResource);
}

async function verify(token: string, audience: string): Promise<AppClaims> {
  const { verificationKeys } = await getSigningKey();
  const { payload } = await jwtVerify(token, verificationKeys, {
    issuer: authConfig.issuer,
    audience,
    algorithms: ["ES256"],
    typ: "at+jwt",
    requiredClaims: ["sub", "exp", "iat"],
  });
  if (!isRole(payload.role)) {
    throw new Error("Access token has no valid role claim");
  }
  return payload as AppClaims;
}

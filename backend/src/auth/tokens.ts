import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { authConfig } from "./config.js";
import { getSigningKey } from "./keys.js";
import { scopesForRole, type Role } from "./scopes.js";

export interface IssuedAccessToken {
  accessToken: string;
  expiresAt: string;
  scope: string;
}

/**
 * Issues a short-lived access token for a user whose session was already
 * validated. `sub` is our internal users.id (not the Google subject), so routes
 * can use it directly as a foreign key. No email or name goes in the token.
 */
export async function issueAccessToken(user: { id: number; role: Role }): Promise<IssuedAccessToken> {
  const key = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + authConfig.accessTokenTtlSeconds;
  const scope = scopesForRole(user.role).join(" ");

  const accessToken = await new SignJWT({ role: user.role, scope })
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "at+jwt" })
    .setIssuer(authConfig.issuer)
    .setAudience(authConfig.audience)
    .setSubject(String(user.id))
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(randomUUID())
    .sign(key.privateKey);

  return { accessToken, expiresAt: new Date(exp * 1000).toISOString(), scope };
}

/**
 * Issues an access token for an MCP client (F12). Differs from the web-app token
 * in exactly the ways that keep the two apart: `aud` is the MCP server's
 * canonical URI (RFC 8707), `scope` is only what the user consented to, and
 * `client_id` records which MCP client holds it.
 */
export async function issueMcpAccessToken(grant: {
  userId: number;
  role: Role;
  scope: string;
  clientId: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const key = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = authConfig.mcp.accessTokenTtlSeconds;

  const accessToken = await new SignJWT({ role: grant.role, scope: grant.scope, client_id: grant.clientId })
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "at+jwt" })
    .setIssuer(authConfig.issuer)
    .setAudience(authConfig.mcpResource)
    .setSubject(String(grant.userId))
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .setJti(randomUUID())
    .sign(key.privateKey);

  return { accessToken, expiresIn };
}

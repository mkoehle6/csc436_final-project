import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { authConfig } from "../auth/config.js";
import { verifyMcpAccessToken } from "../auth/jwt.js";
import { isRole, type Role } from "../auth/scopes.js";

/** The authenticated MCP caller, derived only from a validated access token. */
export interface McpCaller {
  userId: number;
  role: Role;
  scopes: string[];
  clientId: string;
}

/**
 * Token verifier for the SDK's bearer-auth middleware (F12). Accepts only tokens
 * this backend issued for the MCP resource (aud = MCP URL, typ at+jwt, ES256,
 * not expired); anything else, including web-app tokens, is a 401.
 */
export const mcpTokenVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims;
    try {
      claims = await verifyMcpAccessToken(token);
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired MCP access token");
    }
    const userId = Number(claims.sub);
    if (
      !Number.isInteger(userId) ||
      userId <= 0 ||
      !isRole(claims.role) ||
      typeof claims.client_id !== "string" ||
      typeof claims.exp !== "number"
    ) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "MCP access token is missing required claims");
    }
    return {
      token,
      clientId: claims.client_id,
      scopes: (claims.scope ?? "").split(" ").filter(Boolean),
      expiresAt: claims.exp,
      resource: new URL(authConfig.mcpResource),
      extra: { userId, role: claims.role },
    };
  },
};

export function callerFromAuthInfo(auth: AuthInfo | undefined): McpCaller {
  const userId = Number(auth?.extra?.userId);
  const role = auth?.extra?.role;
  if (!auth || !Number.isInteger(userId) || !isRole(role)) {
    // Unreachable behind requireBearerAuth; refuse rather than run unauthenticated.
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Missing MCP authentication");
  }
  return { userId, role, scopes: auth.scopes, clientId: auth.clientId };
}

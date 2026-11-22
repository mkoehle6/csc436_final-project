import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { authConfig } from "../auth/config.js";
import { db } from "../db/client.js";
import { oauthAuthorizationCodes, oauthRefreshTokens } from "../db/schema.js";

/**
 * Storage for MCP OAuth grants (F12). Raw codes and refresh tokens are only ever
 * returned to the client; the database holds their SHA-256 hashes.
 */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");
const fromNow = (ms: number) => new Date(Date.now() + ms);

export interface CodeGrant {
  clientId: string;
  redirectUri: string;
  userId: number;
  scope: string;
  codeChallenge: string;
  resource: string;
}

export async function createAuthorizationCode(grant: CodeGrant): Promise<string> {
  const code = newSecret();
  await db.insert(oauthAuthorizationCodes).values({
    ...grant,
    codeHash: sha256(code),
    expiresAt: fromNow(authConfig.mcp.authorizationCodeTtlMs),
  });
  return code;
}

export type ConsumeCodeResult =
  | { ok: true; id: number; grant: CodeGrant }
  | { ok: false; reason: "unknown" | "expired" | "reused" };

/**
 * Marks a code used and returns its grant. A code presented a second time means
 * it leaked (or a client is replaying it): every refresh token issued from it is
 * revoked, so the first redemption's tokens stop working too.
 */
export async function consumeAuthorizationCode(code: string): Promise<ConsumeCodeResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, sha256(code)))
      .for("update");
    if (!row) return { ok: false, reason: "unknown" } as const;
    if (row.usedAt) {
      await tx
        .update(oauthRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(oauthRefreshTokens.familyId, row.id), isNull(oauthRefreshTokens.revokedAt)));
      return { ok: false, reason: "reused" } as const;
    }
    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" } as const;

    await tx.update(oauthAuthorizationCodes).set({ usedAt: new Date() }).where(eq(oauthAuthorizationCodes.id, row.id));
    const { clientId, redirectUri, userId, scope, codeChallenge, resource } = row;
    return { ok: true, id: row.id, grant: { clientId, redirectUri, userId, scope, codeChallenge, resource } } as const;
  });
}

export interface RefreshGrant {
  familyId: number;
  clientId: string;
  userId: number;
  scope: string;
  resource: string;
}

export async function issueRefreshToken(grant: RefreshGrant): Promise<string> {
  const token = newSecret();
  await db.insert(oauthRefreshTokens).values({
    ...grant,
    tokenHash: sha256(token),
    expiresAt: fromNow(authConfig.mcp.refreshTokenTtlMs),
  });
  return token;
}

export type RotateResult =
  | { ok: true; grant: RefreshGrant; refreshToken: string }
  | { ok: false; reason: "unknown" | "expired" | "reused" | "revoked" | "wrong_client" };

/**
 * Exchanges a refresh token for a new one (rotation). A token that was already
 * rotated is being reused, which only happens if it leaked: the whole family is
 * revoked, logging out both the attacker and the legitimate client.
 */
export async function rotateRefreshToken(token: string, clientId: string): Promise<RotateResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, sha256(token)))
      .for("update");
    if (!row) return { ok: false, reason: "unknown" } as const;
    if (row.clientId !== clientId) return { ok: false, reason: "wrong_client" } as const;
    if (row.revokedAt) return { ok: false, reason: "revoked" } as const;
    if (row.replacedAt) {
      await tx
        .update(oauthRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(oauthRefreshTokens.familyId, row.familyId), isNull(oauthRefreshTokens.revokedAt)));
      return { ok: false, reason: "reused" } as const;
    }
    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" } as const;

    await tx.update(oauthRefreshTokens).set({ replacedAt: new Date() }).where(eq(oauthRefreshTokens.id, row.id));
    const grant: RefreshGrant = {
      familyId: row.familyId,
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
      resource: row.resource,
    };
    const refreshToken = newSecret();
    await tx.insert(oauthRefreshTokens).values({
      ...grant,
      tokenHash: sha256(refreshToken),
      expiresAt: fromNow(authConfig.mcp.refreshTokenTtlMs),
    });
    return { ok: true, grant, refreshToken } as const;
  });
}

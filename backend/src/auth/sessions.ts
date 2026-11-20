import { createHash } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { authSessions, oauthLoginStates, users } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { authConfig } from "./config.js";
import { pkceChallenge, randomToken, type GoogleIdentity } from "./google.js";

/** Database side of the login flow: one-time login states, users and refresh sessions. */

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fromNow = (ms: number) => new Date(Date.now() + ms);

/** Starts a login: stores state/nonce/PKCE verifier and returns what the redirect needs. */
export async function createLoginState() {
  // Sweep abandoned logins so this table cannot grow without bound.
  await db.delete(oauthLoginStates).where(lt(oauthLoginStates.expiresAt, new Date()));

  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(48);
  await db.insert(oauthLoginStates).values({
    state,
    nonce,
    codeVerifier,
    expiresAt: fromNow(authConfig.loginStateTtlMs),
  });
  return { state, nonce, codeChallenge: pkceChallenge(codeVerifier) };
}

/** Single-use: deletes the row and returns it only if it has not expired. */
export async function consumeLoginState(state: string) {
  const [row] = await db.delete(oauthLoginStates).where(eq(oauthLoginStates.state, state)).returning();
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return { nonce: row.nonce, codeVerifier: row.codeVerifier };
}

/** Finds the user for a Google identity, creating a `viewer` on first login. */
export async function upsertUser(identity: GoogleIdentity) {
  const existing = await db.query.users.findFirst({ where: eq(users.oidcSubject, identity.subject) });
  if (existing) {
    if (existing.email !== identity.email || existing.displayName !== identity.displayName) {
      const [updated] = await db
        .update(users)
        .set({ email: identity.email, displayName: identity.displayName })
        .where(eq(users.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }

  const [created] = await db
    .insert(users)
    .values({ oidcSubject: identity.subject, email: identity.email, displayName: identity.displayName })
    .returning();
  if (!created) throw new Error("Failed to create user");
  await recordAudit({
    actorUserId: created.id,
    action: "user.create",
    entityType: "user",
    entityId: created.id,
    before: null,
    after: { id: created.id, role: created.role },
  });
  return created;
}

/** Creates a refresh session; returns the raw cookie value (only its hash is stored). */
export async function createSession(userId: number) {
  const token = randomToken();
  const expiresAt = fromNow(authConfig.sessionTtlMs);
  const [session] = await db
    .insert(authSessions)
    .values({ tokenHash: hash(token), userId, expiresAt })
    .returning();
  return { token, sessionId: session?.id, expiresAt };
}

/** Returns the session and its user if the cookie value is valid, unexpired and not revoked. */
export async function findActiveSession(token: string) {
  const [row] = await db
    .select({ session: authSessions, user: users })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(
      and(
        eq(authSessions.tokenHash, hash(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function revokeSession(token: string) {
  const [row] = await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.tokenHash, hash(token)), isNull(authSessions.revokedAt)))
    .returning();
  return row ?? null;
}

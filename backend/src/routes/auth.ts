import { Router, type CookieOptions, type Request, type Response } from "express";
import { z } from "zod";
import { authConfig, LOGIN_STATE_COOKIE, SESSION_COOKIE } from "../auth/config.js";
import { buildAuthorizationUrl, exchangeCode, LoginFlowError, verifyIdToken } from "../auth/google.js";
import { getSigningKey } from "../auth/keys.js";
import {
  consumeLoginState,
  createLoginState,
  createSession,
  findActiveSession,
  revokeSession,
  upsertUser,
} from "../auth/sessions.js";
import { issueAccessToken } from "../auth/tokens.js";
import { recordAudit } from "../lib/audit.js";
import { ApiErrors } from "../lib/errors.js";
import { isAllowedOrigin } from "../lib/origins.js";
import { limits } from "../middleware/rateLimit.js";

/**
 * Login flow (F7):
 *   GET  /auth/login     → 302 to Google with PKCE challenge, state and nonce
 *   GET  /auth/callback  → validates state, exchanges code, validates ID token,
 *                          sets the httpOnly session cookie, 302 back to the app
 *   POST /auth/token     → session cookie → short-lived access token (JSON)
 *   POST /auth/logout    → revokes the session, clears the cookie (204)
 *   GET  /.well-known/jwks.json → public key for verifying our access tokens (F8)
 */
export const authRouter = Router();

// S1: logins are the classic brute-force/abuse target, so they get a tighter limit than /api.
const loginLimiter = limits.login();
// Token refresh runs on every page load and ~every 14 min, so it gets a roomier limit.
const tokenLimiter = limits.token();

function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: authConfig.secureCookies,
    // Lax is required: the callback is a top-level redirect *from* Google.
    sameSite: "lax",
    path: "/auth",
  };
}

function cookieOptions(maxAgeMs: number): CookieOptions {
  return { ...baseCookieOptions(), maxAge: maxAgeMs };
}

function clearCookie(res: Response, name: string) {
  res.clearCookie(name, baseCookieOptions());
}

function readCookie(req: Request, name: string): string | undefined {
  const value: unknown = req.cookies?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The token and logout endpoints act on a cookie, so they are CSRF targets.
 * Browsers always send Origin on cross-origin POSTs; require it to be ours.
 */
function requireAllowedOrigin(req: Request) {
  if (!isAllowedOrigin(req.header("origin"))) {
    throw ApiErrors.forbidden("Origin not allowed");
  }
}

authRouter.get("/auth/login", loginLimiter, async (_req, res, next) => {
  try {
    const { state, nonce, codeChallenge } = await createLoginState();
    // Binds the login to this browser: the callback must present the same state in a cookie.
    res.cookie(LOGIN_STATE_COOKIE, state, cookieOptions(authConfig.loginStateTtlMs));
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, buildAuthorizationUrl({ state, nonce, codeChallenge }));
  } catch (err) {
    next(err);
  }
});

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

authRouter.get("/auth/callback", loginLimiter, async (req, res) => {
  const fail = (reason: string, detail?: string) => {
    req.log.warn({ reason, detail }, "login failed");
    res.redirect(302, `${authConfig.appBaseUrl}/?login=failed`);
  };

  const cookieState = readCookie(req, LOGIN_STATE_COOKIE);
  clearCookie(res, LOGIN_STATE_COOKIE);
  res.setHeader("Cache-Control", "no-store");

  if (typeof req.query.error === "string") {
    fail("provider_error", req.query.error); // e.g. access_denied when the user cancels
    return;
  }
  const query = callbackQuerySchema.safeParse(req.query);
  if (!query.success) {
    fail("bad_callback_query");
    return;
  }
  if (!cookieState || cookieState !== query.data.state) {
    fail("state_mismatch");
    return;
  }

  try {
    const login = await consumeLoginState(query.data.state);
    if (!login) {
      fail("state_unknown_or_expired");
      return;
    }
    const idToken = await exchangeCode(query.data.code, login.codeVerifier);
    const identity = await verifyIdToken(idToken, login.nonce);
    const user = await upsertUser(identity);
    const session = await createSession(user.id);

    await recordAudit({
      actorUserId: user.id,
      action: "auth.login",
      entityType: "auth_session",
      entityId: session.sessionId,
      before: null,
      after: { userId: user.id, expiresAt: session.expiresAt },
    });

    res.cookie(SESSION_COOKIE, session.token, cookieOptions(authConfig.sessionTtlMs));
    res.redirect(302, `${authConfig.appBaseUrl}/`);
  } catch (err) {
    if (err instanceof LoginFlowError) {
      fail(err.reason, err.message);
      return;
    }
    req.log.error({ err }, "login callback error");
    fail("internal_error");
  }
});

authRouter.post("/auth/token", tokenLimiter, async (req, res, next) => {
  try {
    requireAllowedOrigin(req);
    res.setHeader("Cache-Control", "no-store");

    const token = readCookie(req, SESSION_COOKIE);
    const active = token ? await findActiveSession(token) : null;
    if (!active) {
      if (token) clearCookie(res, SESSION_COOKIE);
      throw ApiErrors.unauthorized("Not signed in");
    }

    const { user } = active;
    const issued = await issueAccessToken({ id: user.id, role: user.role });
    res.status(200).json({
      accessToken: issued.accessToken,
      tokenType: "Bearer",
      expiresAt: issued.expiresAt,
      scope: issued.scope,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/auth/logout", tokenLimiter, async (req, res, next) => {
  try {
    requireAllowedOrigin(req);
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const revoked = await revokeSession(token);
      if (revoked) {
        await recordAudit({
          actorUserId: revoked.userId,
          action: "auth.logout",
          entityType: "auth_session",
          entityId: revoked.id,
          before: { revokedAt: null },
          after: { revokedAt: revoked.revokedAt },
        });
      }
    }
    clearCookie(res, SESSION_COOKIE);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

authRouter.get("/.well-known/jwks.json", async (_req, res, next) => {
  try {
    const { publicJwks } = await getSigningKey();
    // Public and identical for every caller, so shared caches may hold it briefly (D6).
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(publicJwks);
  } catch (err) {
    next(err);
  }
});

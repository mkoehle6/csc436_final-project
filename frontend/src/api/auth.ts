import type { AuthUser } from "../types/trivia";
import { API_BASE_URL, ApiRequestError, isApiErrorBody } from "./client";

/**
 * Talks to the backend's login endpoints (F7). The browser never sees Google's
 * tokens or the client secret: the backend runs the OAuth flow and keeps the
 * refresh session in an httpOnly cookie that JavaScript cannot read. This module
 * only exchanges that cookie for a short-lived access token, kept in memory.
 */

export interface AuthSession {
  accessToken: string;
  expiresAt: string;
  scope: string;
  user: AuthUser;
}

function isAuthSession(value: unknown): value is AuthSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.user !== "object" || v.user === null) return false;
  const user = v.user as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    typeof v.expiresAt === "string" &&
    typeof v.scope === "string" &&
    typeof user.id === "number" &&
    typeof user.email === "string" &&
    (user.displayName === null || typeof user.displayName === "string") &&
    (user.role === "viewer" || user.role === "operator")
  );
}

/** Full-page navigation target that starts the Google login. */
export const loginUrl = () => `${API_BASE_URL}/auth/login`;

/** Returns the current session, or null if the user is not signed in (401). */
export async function fetchAuthSession(): Promise<AuthSession | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/auth/token`, { method: "POST", credentials: "include" });
  } catch {
    throw new ApiRequestError(0, "NETWORK_ERROR", "Could not reach the sign-in server.");
  }
  if (res.status === 401) return null;

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (isApiErrorBody(body)) throw new ApiRequestError(res.status, body.error.code, body.error.message);
    throw new ApiRequestError(res.status, "UNKNOWN_ERROR", `Sign-in check failed with status ${res.status}`);
  }
  if (!isAuthSession(body)) {
    throw new ApiRequestError(502, "INVALID_RESPONSE", "Sign-in server returned an unexpected response.");
  }
  return body;
}

export async function logout(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    throw new ApiRequestError(0, "NETWORK_ERROR", "Could not reach the server to sign out.");
  }
  if (!res.ok) {
    throw new ApiRequestError(res.status, "LOGOUT_FAILED", `Sign-out failed with status ${res.status}`);
  }
}

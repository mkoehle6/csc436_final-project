import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchAuthSession, loginUrl, logout, type AuthSession } from "../api/auth";
import { AuthContext, type AuthContextValue, type AuthState } from "./authContext";

/** Refresh the access token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * The backend redirects to /?login=failed when a Google login fails. Read and
 * strip the flag once, at load, so refreshing the page does not show it again.
 */
function consumeLoginFailedFlag(): boolean {
  const url = new URL(window.location.href);
  if (url.searchParams.get("login") !== "failed") return false;
  url.searchParams.delete("login");
  window.history.replaceState(null, "", url.toString());
  return true;
}
const LOGIN_FAILED_ON_LOAD = consumeLoginFailedFlag();

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [loginFailed, setLoginFailed] = useState(LOGIN_FAILED_ON_LOAD);
  const [checkToken, setCheckToken] = useState(0);
  // The access token lives only in memory, never in localStorage where any injected script could read it.
  const sessionRef = useRef<AuthSession | null>(null);

  const applySession = useCallback((session: AuthSession | null) => {
    sessionRef.current = session;
    setState(session ? { status: "authenticated", user: session.user } : { status: "anonymous" });
  }, []);

  // Initial sign-in check (and re-check on retry), with visible loading/error states (F2).
  // State starts as "loading"; retry() sets it again before bumping checkToken.
  useEffect(() => {
    let cancelled = false;
    fetchAuthSession()
      .then((session) => {
        if (!cancelled) applySession(session);
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [applySession, checkToken]);

  /** Silent refresh: no loading flash. */
  const refresh = useCallback(async () => {
    const session = await fetchAuthSession();
    applySession(session);
    return session;
  }, [applySession]);

  // Refresh shortly before the access token expires so API calls never carry a stale one.
  useEffect(() => {
    const session = sessionRef.current;
    if (state.status !== "authenticated" || !session) return;
    const delay = Math.max(0, Date.parse(session.expiresAt) - Date.now() - REFRESH_MARGIN_MS);
    const timer = window.setTimeout(() => {
      // A network blip keeps the current state; getAccessToken() will try again on next use.
      refresh().catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state, refresh]);

  const getAccessToken = useCallback(async () => {
    const session = sessionRef.current;
    if (session && Date.parse(session.expiresAt) - Date.now() > REFRESH_MARGIN_MS) {
      return session.accessToken;
    }
    return (await refresh())?.accessToken ?? null;
  }, [refresh]);

  const signIn = useCallback(() => {
    window.location.assign(loginUrl());
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logout();
      applySession(null);
    } catch (err) {
      setState({ status: "error", message: errorMessage(err) });
    }
  }, [applySession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      loginFailed,
      dismissLoginFailed: () => setLoginFailed(false),
      signIn,
      signOut,
      retry: () => {
        setState({ status: "loading" });
        setCheckToken((t) => t + 1);
      },
      getAccessToken,
    }),
    [state, loginFailed, signIn, signOut, getAccessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

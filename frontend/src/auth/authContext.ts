import { createContext, useContext } from "react";
import type { AuthUser } from "../types/trivia";

export type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "error"; message: string };

export interface AuthContextValue {
  state: AuthState;
  /** True when the browser just came back from a failed Google login. */
  loginFailed: boolean;
  dismissLoginFailed: () => void;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** Re-runs the sign-in check after an error. */
  retry: () => void;
  /** A valid access token for API calls, refreshed if close to expiry; null if signed out. */
  getAccessToken: () => Promise<string | null>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

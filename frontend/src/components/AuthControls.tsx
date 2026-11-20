import { useState } from "react";
import { useAuth } from "../auth/authContext";

/** Header sign-in area. Every state of the sign-in check is visible (F2). */
export function AuthControls() {
  const { state, loginFailed, dismissLoginFailed, signIn, signOut, retry } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
    setSigningOut(false);
  };

  return (
    <div className="auth-controls">
      {loginFailed && state.status !== "authenticated" && (
        <p className="auth-controls__alert" role="alert">
          Sign-in didn&apos;t complete. Please try again.
          <button
            type="button"
            className="auth-controls__dismiss"
            onClick={dismissLoginFailed}
            aria-label="Dismiss sign-in error"
          >
            ×
          </button>
        </p>
      )}

      {state.status === "loading" && (
        <span className="auth-controls__status" role="status">
          Checking sign-in…
        </span>
      )}

      {state.status === "error" && (
        <span className="auth-controls__alert" role="alert">
          Sign-in unavailable: {state.message}
          <button type="button" className="btn-secondary" onClick={retry}>
            Retry
          </button>
        </span>
      )}

      {state.status === "anonymous" && (
        <button type="button" className="btn-secondary" onClick={signIn}>
          Sign in with Google
        </button>
      )}

      {state.status === "authenticated" && (
        <>
          <span className="auth-controls__user">
            {state.user.displayName ?? state.user.email}
            <span className="auth-controls__role">{state.user.role}</span>
          </span>
          <button type="button" className="btn-secondary" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </>
      )}
    </div>
  );
}

# F7: OAuth 2.0 / OpenID Connect login (HAR of a real sign-in)

**Flow:** Authorization Code with **PKCE (S256)**, plus `state` (CSRF) and `nonce`
(ID-token replay), against Google. The backend verifies Google's ID token (signature
via Google's JWKS, issuer, audience, expiry, nonce: F8), then issues **its own**
short-lived ES256 access token and a refresh session in an **httpOnly cookie**. The
browser never stores a Google token, and keeps our access token only in memory.

## Evidence

* **HAR:** `f7/signin-staging.redacted.har`. The student signed in on staging in a
  private window on 2026-11-24 (UTC), then answered one question.
* **Redaction:** the browser exported a *sanitized* HAR (Chrome/Edge already strip
  `Cookie`, `Set-Cookie` and `Authorization`). It was then passed through
  `scripts/redact-har.mjs`, which:
  * replaces every non-public query value (state, nonce, code, code_challenge, …)
    with `[REDACTED]`;
  * drops all bodies;
  * reduces Google's own requests to host + path + status;
  * refuses to write if anything JWT-, email-, Google-code- or session-cookie-shaped
    survives.

  The raw HAR was deleted immediately after. The redactor was tested on a fake HAR
  with planted secrets (none leaked) and its refusal guard was tested too.

## The flow, step by step (entries from the HAR)

| # | Request | Status | What it shows |
| --- | --- | --- | --- |
| 0 | `GET trivia-staging-api…/auth/login` | **302** → `accounts.google.com/o/oauth2/v2/auth` | the authorization request, below |
| 1–38 | Google's sign-in pages (`accounts.google.com`, `gstatic`, …) | 200/302 | account chooser and Google's own session handling; only hosts and paths kept |
| 39 | `GET accounts.google.com/signin/oauth/v3/consent` | **302** → `…/auth/callback?state=[R]&code=[R]&iss=[R]&scope=…` | Google returns a one-time **code**, bound to our `state` |
| 40 | `GET trivia-staging-api…/auth/callback` | **302** → `https://trivia-staging.burnscodev.com/` | the backend checks state, exchanges code + PKCE verifier, verifies the ID token, creates the session cookie, returns to the app. `Cache-Control: no-store` |
| 41 | `GET trivia-staging…/` | 200 | the app loads |
| 43 | `POST trivia-staging-api…/auth/token` | **200** | the app turns the httpOnly session cookie into a short-lived access token (CORS: exact origin + credentials, `no-store`) |
| 45, 48, 50 | `OPTIONS …` | 204 | CORS preflights for the authenticated calls |
| 47 | `POST …/api/sessions` | **201** | signed-in game session (bearer token; header stripped by the browser export) |
| 49 | `POST …/api/sessions/6/answers` | **201** | server-scored answer |

### Entry 0: the authorization request

```
https://accounts.google.com/o/oauth2/v2/auth
  client_id             = 305226025981-5lqbt6tcdr9pctt8cb65cn32jsncvnkn.apps.googleusercontent.com   (public; staging client)
  redirect_uri          = https://trivia-staging-api.burnscodev.com/auth/callback               (exact, registered with Google)
  response_type         = code                                                                     (authorization code flow)
  scope                 = openid email profile                                                     (OIDC: we get an ID token)
  state                 = [REDACTED]        CSRF protection; also stored in an httpOnly cookie and compared at callback
  nonce                 = [REDACTED]        must reappear inside the ID token (replay protection)
  code_challenge        = [REDACTED]        PKCE: SHA-256 of a secret verifier the server keeps
  code_challenge_method = S256
  prompt                = select_account
```

### Cookies (not in the sanitized HAR, so captured separately)

Live from staging, value redacted:

```
$ curl -sD - -o /dev/null https://trivia-staging-api.burnscodev.com/auth/login | grep -i set-cookie
Set-Cookie: tn_oauth_state=[REDACTED]; Max-Age=600; Path=/auth; Expires=…; HttpOnly; Secure; SameSite=Lax
```

The session cookie `tn_session`, set at step 40, uses the same `cookieOptions()`
(`backend/src/routes/auth.ts`): **HttpOnly** (JavaScript cannot read it), **Secure**,
**SameSite=Lax** (needed because the callback is a top-level redirect from Google),
**Path=/auth** (sent only to the auth endpoints, never to `/api`), with the session
lifetime as Max-Age. `backend/tests/authFlow.test.ts` asserts HttpOnly and
SameSite=Lax on the issued cookie.

## Why this is safe

* **Code interception is useless** without the PKCE verifier, which never leaves the
  server.
* **Login CSRF / mix-up:** the callback rejects a `state` that does not match the
  httpOnly state cookie, and the ID token must carry our `nonce` and audience (F8
  tests, one per check).
* **Token theft:** the refresh credential is an httpOnly, path-scoped cookie; only its
  SHA-256 hash is stored server-side (`auth_sessions.token_hash`). Access tokens live
  15 minutes, in memory only.
* **Every login and logout is audited** (`auth.login`, `auth.logout`: F6).

## Limits

* The browser's sanitized export removed `Set-Cookie` and `Authorization`. Cookie
  attributes are therefore shown by the live `curl` and the test, not by the HAR.
* `Location` headers of relative URLs (entries 47 and 49) show `[REDACTED]` because of
  a redactor bug found while writing this up. It is fixed in
  `scripts/redact-har.mjs` (relative URLs now resolve against the request); the F3
  transcript shows those `Location` values.

# Design: TriviaNerd MCP server (F12) and MCP App (F13)

Status: approved 2026-11-22. Implemented in four phases, each through CI → staging → Promote.

Spec baseline: MCP **2026-07-28** (authorization), MCP Apps extension **2026-01-26 (stable)**,
TypeScript SDK **v2** (`@modelcontextprotocol/server`, `/express`, `/node`; `@modelcontextprotocol/ext-apps`).

## 1. Where it runs

The MCP server is part of the existing backend, served at **`/mcp`** (Streamable HTTP,
stateless). Canonical resource URIs (RFC 8707):

| Environment | MCP resource URI |
| --- | --- |
| production | `https://trivia-api.burnscodev.com/mcp` |
| staging | `https://trivia-staging-api.burnscodev.com/mcp` |

No extra service or cost; same pipeline. Tools call the application's own functions,
never the web API with a forwarded token, so the spec's **no token passthrough** rule holds
by construction.

## 2. Authorization: the backend is the MCP authorization server

Google remains the identity provider for people; for MCP clients the backend is an
OAuth 2.1 authorization server (the v2 SDK covers only the resource-server side).

| Piece | Endpoint | Notes |
| --- | --- | --- |
| Protected Resource Metadata (RFC 9728) | `/.well-known/oauth-protected-resource/mcp` and root form | `authorization_servers`, `scopes_supported` (basic set) |
| AS metadata (RFC 8414) | `/.well-known/oauth-authorization-server` | S256-only PKCE, `client_id_metadata_document_supported: true`, public clients, `iss` parameter |
| Client registration | **CIMD** (Client ID Metadata Documents) | `client_id` is an HTTPS URL; document fetched with SSRF protection (HTTPS only, private addresses refused, no redirects, timeout, size cap), cached. DCR (deprecated in 2026-07-28) only if a host needs it. |
| Authorize + consent | `/auth/oauth/authorize` | Reuses the Google login session; consent page shows client name, **redirect hostname** (warning for localhost), requested permissions; Allow/Deny |
| Token | `/auth/oauth/token` | Authorization code + PKCE; `resource` must equal the MCP URI; 15-min access token with **`aud` = MCP URI**; rotating refresh token with reuse detection |

**Audience separation:** web-app tokens (`aud: trivianerd-api`) are refused by `/mcp`;
MCP tokens are refused by the web API.

## 3. Tools and scopes

| Tool | Scope | Notes |
| --- | --- | --- |
| `get_leaderboard` | `trivia:read` | nicknames only |
| `get_random_questions` | `trivia:read` | never includes answers |
| `get_my_stats` | `trivia:read` | caller's own games |
| `add_question` | `questions:write` (operator role) | **write requiring confirmation** |
| `play_trivia` | `trivia:play` | opens the MCP App; starts a scored game |
| `submit_answer` | `trivia:play` | app-only (`_meta.ui.visibility: ["app"]`); feeds the live leaderboard |

- **Confirmation (server-enforced):** the first `add_question` call creates nothing and
  returns a preview plus a 5-minute, single-use confirmation code bound to the user and the
  exact payload; only a second call with that code creates the question.
- **Insufficient scope:** HTTP 403 with
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"`.
- **Role cap:** consent never grants more than the user's role allows.
- **Audit:** every tool call (including refused ones): actor from the token, tool, client,
  outcome, argument summary.

## 4. MCP App (F13)

New `mcp-app/` workspace: React + TypeScript + Vite, bundled into one HTML file, served as
`ui://trivianerd/quiz.html` (`text/html;profile=mcp-app`). Quiz card from `play_trivia`;
answers via `submit_answer` through the host; leaderboard panel. No network access of its
own (default CSP `connect-src 'none'`); every call goes through the host's authenticated
MCP connection and is scope-checked on the server. To verify with a real host: that
app-initiated calls carry the connection's authorization (not stated explicitly in the spec).

## 5. Data (migration 0004, reversible)

`oauth_authorization_codes` (hashed, single-use, 10 min), `oauth_refresh_tokens` (hashed,
rotation family, revocable), `oauth_login_states.return_to` (resume authorize after login);
phase 2 adds `mcp_pending_actions` (confirmation codes).

## 6. Security checklist

CIMD SSRF protection · exact redirect-URI match · PKCE S256 required · `resource` checked at
authorize and token · consent CSRF (SameSite cookie + Origin check + signed, user-bound
request) and anti-framing · `state` and `iss` returned · codes and refresh tokens stored
hashed · code reuse and refresh-token reuse revoke the token family · rate limits on OAuth
endpoints · audience separation · public OAuth/MCP endpoints use `Access-Control-Allow-Origin: *`
**without credentials** (bearer tokens, no cookies), everything cookie-based keeps the exact
allowlist.

## 7. Phases

1. OAuth authorization server, consent screen, migration 0004
2. `/mcp` with the four core tools, scopes, 403 challenge, confirmation, audit
3. MCP App workspace, `play_trivia` and `submit_answer`
4. Host testing (MCP Inspector, then Claude custom connector against staging) and recording

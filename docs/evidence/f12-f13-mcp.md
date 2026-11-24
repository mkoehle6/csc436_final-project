# F12 / F13: MCP server and MCP App (evidence)

Design: `docs/design/mcp.md` (tools, scopes, authorization server, MCP App, security
checklist). Endpoint: `https://trivia-staging-api.burnscodev.com/mcp` (staging);
production has the same at `trivia-api.burnscodev.com/mcp`.

## F12: MCP server

| Claim | Evidence |
| --- | --- |
| 3+ read tools, 1 write tool requiring confirmation | tools `get_leaderboard`, `get_random_questions`, `get_my_stats` (`trivia:read`); `add_question` (`questions:write` + operator role) |
| Uses our tokens and scopes (OAuth 2.1, audience-bound) | MCP clients register by Client ID Metadata Document, sign in with Google through our consent screen, and get tokens with `aud` = the MCP URL. `backend/tests/mcpOauth.test.ts` (20 tests) |
| Missing scope → step-up, not silent failure | **MCP Inspector screenshot:** HTTP 403 `insufficient_scope` and the Inspector's step-up dialog asking for the extra scope |
| Consent never grants more than the role allows | **MCP Inspector screenshot:** consent screen capping the requested scopes to the user's role |
| Write requires server-enforced confirmation | **MCP Inspector, live on staging:** 1st `add_question` call returned a preview and a confirmation code and created nothing; 2nd call with the code **created the question**; **3rd call with the same code was refused** (single-use). Tests in `backend/tests/mcp.test.ts`: creates nothing on the first call, then only with the right code, same payload, once; another user's code does not work; a demoted operator cannot add questions |
| Every tool call audited | `mcp.tool_call` rows (actor, tool, client id, outcome, argument summary), including refused calls: `f6-audit-trail.md` |

## F13: MCP App (inside a real MCP host)

| Claim | Evidence |
| --- | --- |
| Interactive React/TS app rendered inside the host | `play_trivia` returns the `ui://trivianerd/quiz.html` resource (`text/html;profile=mcp-app`). **Recording:** the quiz played inside **Claude** (custom connector to staging), through to "game over" and the leaderboard |
| Same authorization as the rest of the app | the app has no network access of its own (CSP `connect-src 'none'`); answers go through the host's authenticated MCP connection to the app-only tool `submit_answer` (`trivia:play`), scope-checked on the server. The answers were recorded and scored under the signed-in user's account (checked server-side) |
| Tests | `backend/tests/mcpApp.test.ts` (5 tests): `play_trivia` links the UI and `submit_answer` is app-only; the resource is served with the MCP App MIME type and an image-only CSP; a read-only connection gets 403 `insufficient_scope` for the app; an app cannot score answers in someone else's game; answers are scored on the server, audited as `mcp`, and appear on the website's live leaderboard |

### Recording

* **File:** `Screen Recording 2026-11-22 184415.mp4` (Windows Snipping Tool,
  recorded 2026-11-22 18:44 local / 23:44 UTC, 179 MB).
* **Shows:** the quiz played in the MCP App inside a Claude chat (TriviaNerd custom
  connector to staging), through to the game-over screen with the leaderboard.
  _Student: confirm, and add anything else it shows (e.g. connecting and consent)._
* **Where:** submitted with the project (not committed: it exceeds GitHub's 100 MB
  file limit). _Student: add the upload location or link here._
* **Redaction:** checked before submission. Frames showing the Google account email,
  "Signed in as …" or the profile picture are trimmed or cropped (see
  `redaction-attestation.md`).

## Bugs found by testing in real hosts (fixed)

* **Consent form rejected in a real browser** (`Origin: null` caused by
  `Referrer-Policy: no-referrer`). Fixed in `13aeb6c` with a regression test that
  reproduces browser behaviour (AI-use log, challenged claim 1).
* **MCP Inspector could not register** (no CIMD document for it). Fixed in `474c2a2`
  (`/oauth/clients/mcp-inspector.json`).

## Screenshots

* [`f12-inspector-step-up-insufficient-scope.png`](screenshots/f12-inspector-step-up-insufficient-scope.png)
* [`f12-consent-viewer-role-capped.png`](screenshots/f12-consent-viewer-role-capped.png)
* [`f12-consent-operator.png`](screenshots/f12-consent-operator.png)

(Index with descriptions: `screenshots/README.md`.)

# TriviaNerd — Simpsons Trivia

A trivia web application built with React + TypeScript (frontend) and
Express + TypeScript (backend), using [The Simpsons API](https://thesimpsonsapi.com/)
as its third-party data source. Built against the course's final web
application requirements checklist (F1–F13, D1–D11, S1–S2, Q1–Q4).

## Project structure

```
frontend/     React + TypeScript (Vite) client — the TriviaNerd UI
backend/      Express + TypeScript REST API, PostgreSQL + Drizzle ORM, OIDC auth
mcp-server/   MCP server (read/write tools, OAuth-protected) — planned
mcp-app/      Interactive MCP App (React/TS) — planned
infra/        Deployment config / IaC — planned
docs/         Architecture + trust-boundary diagrams, runbook, postmortem
```

## Prerequisites

- Node.js 20+ and npm
- No external accounts needed for local dev (The Simpsons API requires no key)

## Getting started

```powershell
# from the repo root
npm install           # installs all workspaces (frontend, backend, ...)

# backend: copy env, create signing key, run migrations, start dev server
cd backend
Copy-Item .env.example .env
#   then edit .env: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see "Auth" below)
npm run auth:keygen    # writes AUTH_PRIVATE_JWK into .env (never printed)
npm run db:migrate
npm run dev            # http://localhost:3001

# after signing in once, make yourself an operator:
npm run user:set-role -- you@example.com operator

# frontend (separate terminal): copy env, start dev server
cd ..\frontend
Copy-Item .env.example .env.local
npm run dev             # http://localhost:5173
```

## Backend

- **Routes:**

  | Route | Access | Notes |
  | --- | --- | --- |
  | `GET /healthz` | public | 200 when the database answers (503 otherwise), plus the deployed `commit`; Render gates deploys on it. The Simpsons API is deliberately not checked (the app degrades without it). |
  | `GET /api/questions?count&category` | public | random round from the question bank; never includes answers; `Cache-Control: no-store` |
  | `GET /api/questions/:id` | public | one question, no answer; 404 |
  | `POST /api/questions/:id/check` | public | anonymous play: right/wrong + reveal; nothing stored; 400/404 |
  | `POST /api/questions` | operator + `questions:write` | 201 + Location; 409 duplicate; audited |
  | `DELETE /api/questions/:id` | operator + `questions:write` | 204; 404; 409 if answered; audited |
  | `POST /api/sessions` | signed in, `trivia:play` | 201 + Location; audited |
  | `POST /api/sessions/:id/answers` | signed in, `trivia:play` | server-scored; 201 + Location; 404 not yours; 409 repeat; audited |
  | `GET /api/sessions/:id` | signed in, `trivia:read` | session + score; 404 not yours |
- **Live leaderboard (F11):** Server-Sent Events at `GET /api/live/leaderboard`
  (snapshot: `GET /api/leaderboard`, `Cache-Control: public, max-age=5`).
  *Why SSE, not WebSockets:* updates only flow server → browser; SSE is plain
  HTTPS, so Render, the CDN and the CORS allowlist treat it like any GET; and
  the browser's `EventSource` reconnects by itself and sends `Last-Event-ID`,
  which is exactly the resume mechanism needed. Each event is written to
  `live_events` in the same transaction as the answer it announces (ids
  serialised with a transaction-level advisory lock so they commit in order);
  every stream keeps a cursor and sends events with id > cursor, so a client
  reconnecting with its last id (even to a restarted server) gets exactly what
  it missed. Players appear only under synthetic nicknames (`live/nickname.ts`),
  never real names. Kill-and-recover demo across a real process restart:
  `npm run demo:live-recovery --workspace=backend`.
- **Question bank:** questions are served from the database and topped up
  from The Simpsons API only while a category holds fewer than 60, so page
  views cause no writes once the bank is warm; if the API is down the bank
  still serves (`degraded: true`). Unnamed extras and "Unknown" occupations
  are filtered out (`backend/src/lib/characterFilters.ts`).
- **Error shape:** every failure returns
  `{ "error": { "code": "...", "message": "...", "details"?: ... } }`.
- **Database:** PostgreSQL via Drizzle ORM (`backend/src/db/schema.ts`), with
  versioned migrations in `backend/src/db/migrations/`. `DATABASE_URL` picks the
  engine (`backend/src/db/client.ts`): a `postgresql://` URL uses a real server
  (Render Postgres in staging/production); a directory path such as
  `./data/pglite` runs embedded PostgreSQL (PGlite) for local development, and
  tests use in-memory PGlite, so no local Postgres install is needed. Primary
  keys on every table, foreign keys (`answers.session_id → game_sessions.id`,
  `answers.question_id → questions.id`, `game_sessions.user_id → users.id`,
  `auth_sessions.user_id → users.id`, `audit_log.actor_user_id → users.id`),
  enum types for role and category, and indexes justified per table (see
  comments in `schema.ts`, e.g. `questions_category_idx` for category
  filtering, `answers_session_id_idx` for scoring lookups).
- **Audit trail:** append-only `audit_log` table, written by
  `backend/src/lib/audit.ts`; the actor is always taken from the validated
  JWT, never from the request body.
- **Auth:** Google is the identity provider; the backend issues its own
  access tokens.
  - `GET /auth/login` → Google (Authorization Code + PKCE S256, `state`,
    `nonce`) → `GET /auth/callback` validates state, exchanges the code,
    validates Google's ID token (JWKS signature, issuer, audience, expiry,
    nonce), creates the user as `viewer` on first login, and sets an httpOnly
    session cookie.
  - `POST /auth/token` swaps that cookie for a 15-minute ES256 access token
    (`typ: at+jwt`, `sub` = users.id, `role`, `scope`); `POST /auth/logout`
    revokes the session. The public key is at `/.well-known/jwks.json`.
  - `requireAuth`/`requireRole`/`requireScope` (`backend/src/middleware/auth.ts`)
    check signature, issuer, audience, expiry, type, role and scope.
    Roles → scopes: viewer = `trivia:read trivia:play`, operator adds
    `questions:write` (`backend/src/auth/scopes.ts`).
  - Google console setup: OAuth client of type *Web application*, authorized
    redirect URI `http://localhost:3001/auth/callback` (plus each deployed
    backend's `/auth/callback`).
- **MCP authorization server (F12, phase 1):** design in
  [`docs/design/mcp.md`](docs/design/mcp.md). Per the MCP authorization spec
  2026-07-28 the backend serves RFC 9728 resource metadata
  (`/.well-known/oauth-protected-resource[/mcp]`) and RFC 8414 server metadata
  (`/.well-known/oauth-authorization-server`). MCP clients identify themselves with
  Client ID Metadata Documents (fetched with SSRF protection,
  `backend/src/oauth/clientMetadata.ts`), sign the user in through the normal Google
  login, show a consent screen, and use authorization code + PKCE (S256) with
  `resource` = the MCP URL (`/auth/oauth/authorize`, `/auth/oauth/token`). Access
  tokens have `aud` = the MCP URL and are refused by the web API (and vice versa);
  scopes are capped by role; refresh tokens rotate, and code or refresh-token reuse
  revokes the whole token family.
- **Rollback:** `npm run db:rollback` reverses the latest migration using
  `backend/src/db/migrations-down/<tag>.down.sql`.
- **Third-party integration:** `backend/src/integrations/simpsonsApi.ts`
  wraps The Simpsons API with a request timeout, bounded retry (5xx only),
  a TTL cache, zod runtime response validation, and typed errors for
  graceful degradation when the provider is down.
- **Rate limiting (S1):** `backend/src/middleware/rateLimit.ts`; every response
  carries `RateLimit-Policy/Limit/Remaining/Reset`, a refusal is 429 +
  `Retry-After` in the standard error shape.

  | Class | Limit | Keyed by | Routes |
  | --- | --- | --- | --- |
  | login | 20/min | IP | `/auth/login`, `/auth/callback` |
  | token | 60/min | IP | `/auth/token`, `/auth/logout` |
  | writes | 30/min | signed-in user (else IP) | `POST /api/sessions`, `POST /api/sessions/:id/answers`; operator question writes (separate budget) |
  | third-party-backed | 30/min | IP | `GET /api/questions` (may top up from The Simpsons API) |
  | API backstop | 120/min | IP | everything under `/api` |

  The Simpsons API is additionally protected from bursts: concurrent requests
  share one in-flight top-up, and top-ups are at least 10 s apart.

## Frontend

- Vite + React 19 + TypeScript (strict). Matches the TriviaNerd mockup:
  header with search + category filter, a question list sidebar, and a quiz
  panel with an image and four answer choices with correct/incorrect
  feedback.
- Every remote call has explicit loading, empty, and error states
  (`frontend/src/components/StatusStates.tsx`,
  `frontend/src/hooks/useTriviaQuestions.ts`). Proven by stopping the
  backend and observing the error state with a working retry button.

## Tests

One command, from the repo root, runs every workspace's tests:

```powershell
npm test
```

CI (`.github/workflows/ci.yml`) runs on every push and pull request:
`npm ci`, `npm run validate:render` (render.yaml against Render's schema),
`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Staging on
Render deploys only after these checks pass.

Covers: input validation (400), anonymous write rejection (401), viewer
write rejection (403), the core scoring calculation
(`backend/tests/scoring.test.ts`, hand-predicted expected values), and the
stubbed third-party integration (`backend/tests/simpsonsApi.test.ts`,
retry/timeout/malformed-response handling with no real network call).

## Deployment (Render)

All infrastructure is defined in [`render.yaml`](render.yaml) (a Render
Blueprint): one project `trivianerd` with **staging** and **production**
environments, each with its own Postgres database, backend web service and
frontend static site. Staging auto-deploys from `main` once CI checks pass;
production never auto-deploys and is promoted from staging.

Validate the Blueprint against Render's published schema
(`https://render.com/schema/render.yaml.json`) before pushing changes to it.

First-time setup (Render dashboard, Hobby workspace):

1. **New → Blueprint**, connect GitHub with access to this repository only,
   select it, and confirm the resources listed in `render.yaml`.
2. Fill in the three `sync: false` secrets for each environment, using a
   **separate Google OAuth client and signing key per environment**:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: from that environment's Google
     OAuth client (redirect URI `https://<api host>/auth/callback`).
   - `AUTH_PRIVATE_JWK`: generate into a scratch file, paste the value, delete
     the file: `cd backend; $env:ENV_FILE="$env:TEMP\stg.env"; npm run auth:keygen`

   All URLs, origins and the CSP are plain values in `render.yaml`.
3. Add the DNS records Render shows for each custom domain (DNS is on
   Cloudflare; keep the records **DNS-only** until Render has issued the
   certificates).

| Environment | Frontend | Backend |
| --- | --- | --- |
| production | `https://trivia.burnscodev.com` | `https://trivia-api.burnscodev.com` |
| staging | `https://trivia-staging.burnscodev.com` | `https://trivia-staging-api.burnscodev.com` |

Frontend and backend must share a registrable domain: browsers treat each
`*.onrender.com` subdomain as a separate site, so the session cookie would not
be sent between them.

### Promoting to production

Production never deploys on its own. Run **GitHub → Actions → "Promote to
production" → Run workflow** (tick *dry run* to only check). For each service,
backend first, it deploys exactly the commit **staging** is running, and only if
staging is healthy and CI passed for that commit; it then waits until production
reports that commit (`/healthz` `commit`, frontend `<meta name="app-commit">`)
and writes a before/after table to the run summary. Logic:
[`scripts/promote.mjs`](scripts/promote.mjs).

One-time setup: in Render, copy each production service's **Settings → Deploy
Hook** URL into a GitHub repository secret (**Settings → Secrets and variables →
Actions**): `RENDER_DEPLOY_HOOK_API_PROD` and `RENDER_DEPLOY_HOOK_WEB_PROD`.
The URLs are secrets: anyone holding one can trigger a deploy.

Migrations run automatically: on staging (free instance) at start, before the
server listens; on production via `preDeployCommand`, so a failing migration
fails the deploy while the previous version keeps serving.

## Status

This is an in-progress build toward the full requirements checklist. Done so
far: F1 (frontend scaffold + strict TS), F2 (loading/empty/error states),
F3 (REST API + error shape + status codes), F4 (persistent PostgreSQL storage
with PK/FK/index), F5 (versioned migrations), F6 (audit trail), the server
side of F7/F8/F9 (OIDC verification + roles, pending a real provider wire-up
on the frontend), F10 (Simpsons API integration with timeout/retry/cache/
validation/degradation), part of Q1 (validation/authorization/integration/
calculation tests). Not yet started: F11 (live updates), F12/F13 (MCP server
+ App), most of the D-series (deployment/CDN/CI-CD/observability), and
S1/S2 evidence beyond the rate-limit middleware itself.

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

- **Routes:** `GET /healthz`, `GET /api/questions`, `POST /api/questions`
  (operator only), `DELETE /api/questions/:id` (operator only),
  `POST /api/sessions`, `POST /api/sessions/:id/answers`,
  `GET /api/sessions/:id`.
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
- **Rollback:** `npm run db:rollback` reverses the latest migration using
  `backend/src/db/migrations-down/<tag>.down.sql`.
- **Third-party integration:** `backend/src/integrations/simpsonsApi.ts`
  wraps The Simpsons API with a request timeout, bounded retry (5xx only),
  a TTL cache, zod runtime response validation, and typed errors for
  graceful degradation when the provider is down.
- **Rate limiting:** `backend/src/middleware/rateLimit.ts`, applied to all
  `/api` routes.

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

# TriviaNerd — Simpsons Trivia

A trivia web application built with React + TypeScript (frontend) and
Express + TypeScript (backend), using [The Simpsons API](https://thesimpsonsapi.com/)
as its third-party data source. Built against the course's final web
application requirements checklist (F1–F13, D1–D11, S1–S2, Q1–Q4).

## Project structure

```
frontend/     React + TypeScript (Vite) client — the TriviaNerd UI
backend/      Express + TypeScript REST API, SQLite + Drizzle ORM, OIDC auth
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

# backend: copy env, run migrations, start dev server
cd backend
Copy-Item .env.example .env
npm run db:migrate
npm run dev            # http://localhost:3001

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
- **Database:** SQLite via Drizzle ORM (`backend/src/db/schema.ts`), with
  versioned migrations in `backend/src/db/migrations/`. Primary keys on every
  table, foreign keys (`answers.session_id → game_sessions.id`,
  `answers.question_id → questions.id`, `game_sessions.user_id → users.id`,
  `audit_log.actor_user_id → users.id`), and indexes justified per table (see
  comments in `schema.ts`, e.g. `questions_category_idx` for category
  filtering, `answers_session_id_idx` for scoring lookups).
- **Audit trail:** append-only `audit_log` table, written by
  `backend/src/lib/audit.ts`; the actor is always taken from the validated
  JWT, never from the request body.
- **Auth:** OIDC access-token validation (`backend/src/auth/jwt.ts`) via
  JWKS, with `requireAuth`/`requireRole` middleware enforcing two roles
  (`viewer`, `operator`) from validated claims only.
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

```powershell
cd backend
npm test
```

Covers: input validation (400), anonymous write rejection (401), viewer
write rejection (403), the core scoring calculation
(`backend/tests/scoring.test.ts`, hand-predicted expected values), and the
stubbed third-party integration (`backend/tests/simpsonsApi.test.ts`,
retry/timeout/malformed-response handling with no real network call).

## Status

This is an in-progress build toward the full requirements checklist. Done so
far: F1 (frontend scaffold + strict TS), F2 (loading/empty/error states),
F3 (REST API + error shape + status codes), F4 (persistent SQLite storage
with PK/FK/index), F5 (versioned migrations), F6 (audit trail), the server
side of F7/F8/F9 (OIDC verification + roles, pending a real provider wire-up
on the frontend), F10 (Simpsons API integration with timeout/retry/cache/
validation/degradation), part of Q1 (validation/authorization/integration/
calculation tests). Not yet started: F11 (live updates), F12/F13 (MCP server
+ App), most of the D-series (deployment/CDN/CI-CD/observability), and
S1/S2 evidence beyond the rate-limit middleware itself.

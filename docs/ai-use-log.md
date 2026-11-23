# AI-use log (Q3)

> Reviewed and owned by the student, 2026-11-23. Dates are 2026.

Tool: Claude Code (Anthropic), used as a pair programmer in VS Code across the
project. The student made every product, provider and cost decision, performed all
account, dashboard, DNS and secret-handling steps, approved every commit and push,
and ran every production promotion.

## What the AI did

| Date | Area | AI contribution | Student decision / verification |
| --- | --- | --- | --- |
| 11-19 | Assessment | Reviewed scaffold; found answers sent to the browser, users never created (FK failures), Google tokens unusable for roles/scopes | Chose option 1: Google login + backend-issued tokens |
| 11-19 | F7–F9 | OIDC login (PKCE, state, nonce), own ES256 tokens, scopes, tests | Created Google OAuth clients; tested sign-in live |
| 11-20 | F4/F5 | SQLite → PostgreSQL (Render Postgres; PGlite locally/tests) | Chose Render Postgres |
| 11-20 | Delivery | render.yaml Blueprint, CI, Promote workflow, `/healthz` commit + DB check | Created Render Blueprint, DNS on Cloudflare, secrets in Render |
| 11-21 | Gameplay, S1, F11 | Server-side scoring, question bank, rate limits, SSE live leaderboard + kill-and-recover demo | Promoted each change through staging |
| 11-22 | F12/F13 | MCP spec research; OAuth AS (CIMD, consent, PKCE, audience-bound tokens), MCP tools with confirmation, MCP App | Approved design; tested with MCP Inspector and Claude; recorded host demo |
| 11-23 | D10, docs | OpenTelemetry, runbook, postmortems, architecture, cost drafts | Grafana account/token; reviewed docs |

## Claims challenged (AI was wrong, caught by testing or by the student)

1. **"The consent form's CSRF check is tested."** It was tested only with a hand-set
   `Origin` header. In a real browser (MCP Inspector against staging) the form failed:
   the page's `Referrer-Policy: no-referrer` makes browsers send `Origin: null`.
   Fixed in `13aeb6c` with a regression test that reproduces browser behaviour.
2. **"Production staying on the old commit proves Blueprint auto-sync is off."** The AI
   itself retracted this: those commits did not touch `render.yaml`, so they proved
   nothing about auto-sync.
3. **Warm-up test predicted exactly 60 questions; it produced 75–78.** The prediction
   ignored the Simpsons API page cache combined with random page selection; the test
   was corrected to the property that must hold, and it exposed a real logging gap
   (warm-up didn't report its final state), fixed in `f5ca602`.
4. **Telemetry bootstrap assumed a valid endpoint URL.** A missing `https://` crashed
   the staging deploy (`a48b74c`); hardened in `08f9a17` (incident 2 in
   `postmortems.md`).
5. **render.yaml change deployed production directly** (incident 1): the AI changed the
   Blueprint without recognising Render's auto-sync behaviour.

**Student:** pick the one you challenged most directly for the dossier's "one challenged
AI claim", and describe in your own words how you checked it.

## How AI output was verified

Every change: typecheck (strict), lint, automated tests with hand-predicted values;
"mutation checks" (deliberately breaking a protection to confirm a test fails);
local runs of the compiled server; CI on GitHub; staging verified from outside
(`/healthz` commit, headers, curl transcripts) before Promote.

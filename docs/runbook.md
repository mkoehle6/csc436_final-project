# TriviaNerd runbook (S2)

For someone who has never seen this system. Every check below can be run from any
terminal with `curl`; dashboard steps name the exact screens.

## 0. What runs where

| Thing | Staging | Production |
| --- | --- | --- |
| Website | https://trivia-staging.burnscodev.com | https://trivia.burnscodev.com |
| API / MCP | https://trivia-staging-api.burnscodev.com | https://trivia-api.burnscodev.com |
| Render services | `trivianerd-web-staging`, `trivianerd-api-staging` (free), `trivianerd-db-staging` | `trivianerd-web-prod`, `trivianerd-api-prod` (paid), `trivianerd-db-prod` |
| Deploys | automatic after CI passes | only via GitHub Actions → **Promote to production** |

Accounts you need: GitHub (repo `mkoehle6/csc436_final-project`), Render (project
*trivianerd*), Cloudflare (zone `burnscodev.com`), Google Cloud (OAuth clients),
Grafana Cloud (telemetry + alerts).

## 1. Is it up? (first 2 minutes of any incident)

```bash
curl -s https://trivia-api.burnscodev.com/healthz
# healthy: {"status":"ok","checks":{"database":"ok"},"commit":"<sha>",...}
curl -s -o /dev/null -w '%{http_code}\n' https://trivia.burnscodev.com/
curl -s "https://trivia-api.burnscodev.com/api/questions?count=1" | head -c 200
```

| Symptom | Meaning | Go to |
| --- | --- | --- |
| `/healthz` 503, `database: unreachable` | backend up, database down | §3 |
| `/healthz` 503 with an **HTML** page (no JSON) | Render itself is not serving the app (e.g. service suspended) | Render dashboard, §2 |
| `/healthz` times out / connection error | backend down or not deployed, **or still starting**: after a resume/restart allow ~3 min (Game Day: resume 03:45 → healthy 03:47:53) before acting | §2 |
| `/api/questions` 502 `UPSTREAM_UNAVAILABLE` | question bank empty **and** Simpsons API down | §4 |
| `/api/questions` 200 with `"degraded":true` | Simpsons API down, app serving saved questions (fine) | §4 |
| 429 `RATE_LIMITED` | a client exceeded a limit; `Retry-After` says when to retry | §6 |
| Login returns to `/?login=failed` | Google OAuth problem | §5 |

Also check: Grafana → Alerting (firing alerts), Grafana → Explore → traces for
`service.name = trivianerd-api`.

## 2. Backend down or a bad deploy

1. Render → the API service → **Events**: is the latest deploy *failed* or *live*?
2. **Logs** of that deploy: look for the last error before `Exited with status 1`.
3. A failed deploy does **not** take the site down: Render only routes traffic to a new
   deploy after `/healthz` returns 200, so the previous version keeps serving.
4. **Roll back production** (if a bad version *is* live): Render → `trivianerd-api-prod`
   → **Events** → previous successful deploy → **Rollback**. Verify:
   `curl -s https://trivia-api.burnscodev.com/healthz` shows the older `commit`.
   Note: the Promote workflow deliberately refuses to move production backwards, so a
   rollback is always this deliberate Render action. Fix forward afterwards through
   staging → Promote.
5. Configuration mistakes (env vars) are fixed in Render → service → **Environment**,
   then **Save, rebuild, and deploy**.

## 3. Database unreachable

1. Render → the database → status. Free staging databases **expire 30 days after
   creation**; if expired, recreate it from the Blueprint (**Manual Sync**), then
   redeploy the staging API (migrations run at start). Staging data is disposable.
2. Production database: check Render status page; restore from Render's daily backup if
   needed (Render → database → **Recovery**).

## 4. The Simpsons API is down

Nothing to do in most cases: the app serves questions already in its bank
(`degraded: true`), retries are bounded, and top-ups are spaced ≥10 s apart. Only an
empty bank (e.g. right after a migration that clears it) returns 502; the bank warms
up automatically when the provider returns. Check:
`curl -s -o /dev/null -w '%{http_code}\n' "https://thesimpsonsapi.com/api/characters?page=1"`.

## 5. Sign-in problems

* `redirect_uri_mismatch` from Google: the OAuth client in Google Cloud must list
  `https://<api host>/auth/callback` exactly.
* `/?login=failed`: Render logs show a `login failed` line with a `reason`
  (`state_mismatch`, `token_exchange_failed`, `server_misconfigured`, …).
* MCP clients: the consent page must be reached on the **API** host; errors there are
  shown as a page, never as a redirect.
* **Rotate a leaked secret:** Google client secret → Google Cloud → Clients → add secret,
  update Render env, redeploy, delete old. Signing key → `npm run auth:keygen` into a
  scratch file, paste into Render env `AUTH_PRIVATE_JWK`, redeploy (all users and MCP
  clients sign in again), delete the file.

## 6. Abuse / rate limits

Limits (per minute): login 20/IP, token 60/IP, writes 30/user, questions 30/IP,
MCP 120/user, API 120/IP. A 429 includes `Retry-After`. Limits are in-memory per
instance (one instance per environment), so a restart resets them.

## 7. Making someone an operator

Locally: `npm run user:set-role -- <email> operator` (after they signed in once).
On Render: add their email to `BOOTSTRAP_OPERATOR_EMAILS` on the API service, redeploy,
and have them sign in with Google again. Audited as `user.role_change`.

## 8. Changing `render.yaml`

Blueprint auto-sync is **off** (see postmortem 2026-11-22). After merging a change to
`render.yaml`, and once the code it needs is on staging **and** production, run Render →
Blueprints → TriviaNerd → **Manual Sync**. CI flags every push that changes it.

## 9. Deploying normally

1. Push to `main`. CI runs; staging deploys when it passes (watch `/healthz` `commit`).
2. Check staging. 3. GitHub → Actions → **Promote to production** → Run workflow
   (optionally *dry run* first). It refuses if staging is unhealthy, CI failed, or the
   change would move production backwards, and warns if staging is behind `main`.

**Builds stopped ("out of build minutes").** The workspace has a **$0 build spend
limit** (`docs/cost.md`). If the 500 included minutes are used up, new builds and
pre-deploy tasks stop, but running services keep serving. Either wait for the next
month, or raise the limit in Render → Workspace settings → Build Pipeline (a cost
decision, which needs the owner's approval).

**Monthly cost check.** Once a month, open Render → Billing and compare the invoice
with `docs/cost.md` (expected ≈ $15). Anything above $20 means a plan or bandwidth
change: find it before the next invoice.

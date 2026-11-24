# D4: CI/CD and rollback

## Pipeline

```
push to main
  └─ GitHub Actions "CI" (.github/workflows/ci.yml)
       npm ci → validate:render → typecheck → lint → test (backend + frontend) → build
       (+ annotation when render.yaml changed: Blueprint sync is manual)
  └─ Render staging: autoDeployTrigger "checksPass", so it deploys only after CI passes,
       and only services whose files changed (buildFilter in render.yaml)
       └─ health gate: traffic switches only after /healthz returns 200
  └─ GitHub Actions "Promote to production" (manual, optional dry run)
       scripts/promote.mjs, per service (backend, then frontend):
         1. staging reports its commit (/healthz `commit`, <meta name="app-commit">)
            and the staging backend is healthy
         2. CI succeeded for exactly that commit (GitHub API)
         3. production is not already on it, and it would not move production backwards
         → Render deploy hook with ?ref=<that commit>; waits until production reports it
```

Production has `autoDeployTrigger: off`: the Promote workflow is its only deploy path.
Incident 1 in `postmortems.md` describes the one time this was bypassed (Blueprint
auto-sync) and the fix.

**Health gate in action:** in incident 2 (`postmortems.md`), a deploy that crashed at
start-up never passed `/healthz`, and Render kept the previous version serving.

## Rollback demo (staging, 2026-11-24 UTC = 2026-11-23 evening local)

The student clicked **Rollback** in Render (Events) to an earlier known-good deploy,
then rolled forward with **Manual Deploy → Deploy latest commit**. Each state was
verified from outside: `/healthz` names the running commit, so rollback is checkable
without the dashboard.

| UTC | Action | Verified from outside |
| --- | --- | --- |
| before | staging on `0dfba4c` | `/healthz` `commit` = `0dfba4c…` |
| 00:33:30 | **Rollback** to `f64d7a9`: Render deploy page shows trigger "Rolled back by you via Dashboard", source `f64d7a9`, "Rolled back to dep-dc1q9a5g…" (screenshot) | `00:34:41` `{"status":"ok","checks":{"database":"ok"},"commit":"f64d7a9f3410811c75383a50c8b88c108ee01d4d","startedAt":"2026-11-24T00:34:35.365Z"}`; questions 200, leaderboard 200, CORS preflight 204 |
| 00:36:44 | **Roll forward**: Manual Deploy → latest commit. Render deploy page: trigger "Manually deployed by you via Dashboard", source `b7f6595`; the log shows a full build (`Checking out commit b7f6595c…`, `npm ci …`, build command) (screenshot) | `00:39:12` `{"status":"ok","checks":{"database":"ok"},"commit":"b7f6595c22436017f6a4bef32d9d9247bb7ad66a","startedAt":"2026-11-24T00:38:59.587Z"}`; questions 200 |

`b7f6595` is the newest commit on `main`. It differs from `0dfba4c` only in docs, so
the backend code is identical to what ran before the demo.

### Interpretation

* **Rollback was quick; rolling forward was a normal build.** The rollback's log
  starts directly with `==> Deploying...` (00:33:32): **no build step**, because Render
  reuses the old deploy's build. Staging's start command runs the migrations
  (`Migrations applied (postgres)`; nothing new to apply, same schema), then the app
  starts, and Render waits for the internal health check on `/healthz` before
  switching traffic. `/healthz` reported `startedAt` 00:34:35. The roll-forward to the latest commit went through
  Render's normal build and deploy (instance up at 00:38:59). Both times, the health
  gate decided when traffic switched.
* **Rollback and the database:** migrations are forward-only at deploy time.
  `f64d7a9` and `0dfba4c` share the same schema (migrations 0000–0005), so the rollback
  was safe. If a deploy had added a migration, an old version would run against the
  newer schema. Our migrations are additive, so old code ignores new columns and
  tables. A destructive change would first need `npm run db:rollback` (F5), run
  deliberately before rolling the code back.
* **Production rollback** uses the same Render button (runbook §2, step 4). Promote
  deliberately **refuses to move production backwards**, so a rollback is always this
  explicit human action. Afterwards, fix forward through staging → Promote.

## Evidence

* Render Events screenshot showing the rollback and the roll-forward (student).
* Promote run summaries in GitHub Actions: each shows the before/after commit table
  for both services. All 12 Promote runs so far succeeded (screenshot of the run list).
  Example, **Promote to production #12** (2026-11-23, run from `main` at `88abbd0`):

  | Service | Staging | Production before | Result |
  | --- | --- | --- | --- |
  | backend | `0dfba4c` | `f64d7a9` | promoted to `0dfba4c` (live after 76 s) |
  | frontend | `0dfba4c` | `a48b74c` | promoted to `0dfba4c` (live after 45 s) |

  Production moved to exactly what staging was running, not to the newest commit on
  `main` (`88abbd0`, docs only), and the run waited until each production service
  reported the new commit before succeeding.
* CI history (screenshot of Actions → CI): 21 runs, one per push to `main`. All the
  runs shown, #15 (`08f9a17`) to #21 (`b7f6595`), passed, each in about 3½–5½ minutes.
  Staging deploys only after the run for that commit succeeds.

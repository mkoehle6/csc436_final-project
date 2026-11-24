# Postmortems (S2)

Blameless format. Times in UTC. Commits are on `main` of `mkoehle6/csc436_final-project`.

---

## Incident 1, 2026-11-22: production deployed without CI or staging (Blueprint auto-sync)

**Severity:** process breach, no user impact. **Detected by:** our own verification
(`/healthz` reports the running commit; the Promote summary showed production already on it).

### Timeline

| Time | Event |
| --- | --- |
| 21:38:12 | Commit `cbdd728` pushed; it changed `render.yaml` (backend build now also builds the MCP App) |
| 21:38:16 | CI starts |
| **21:39:06** | **Production backend restarts on `cbdd728`**: before CI, before staging, without Promote |
| 21:43:42 | CI passes |
| 21:44:45 | Staging backend deploys `cbdd728` (normal "after checks pass" path) |
| 21:47:12 | Promote run reports production backend "already up to date": breach noticed |

### Cause

Render Blueprints had **auto-sync** on. A commit that changes `render.yaml` makes Render
apply the Blueprint to **every** service immediately, and redeploy them, regardless of
`autoDeployTrigger: off` (production) or `checksPass` (staging). The staging-first rule
and the Promote workflow were bypassed by an infrastructure-as-code change.

### Impact

Production ran `cbdd728` for ~5 minutes before CI had approved it. CI then passed; no
errors, no user impact. Risk: a broken build could have reached production directly.

### What went well / badly

* Well: the deviation was detected within minutes by our own tooling (commit in
  `/healthz`, Promote's before/after table).
* Badly: the author changed `render.yaml` without recognising its deploy side effect.

### Actions (done)

1. Blueprint **Auto Sync turned off** in Render; `render.yaml` changes now need a
   deliberate **Manual Sync** (commit `059bf32` documents the rule).
2. CI flags every push that changes `render.yaml` (annotation + run summary).
3. Runbook §8: sync only after the code a Blueprint change needs is on staging and
   production; keep such changes small.

---

## Incident 2, 2026-11-23: staging deploy failed on a telemetry misconfiguration

**Severity:** failed deploy, no user impact. **Detected by:** deploy watcher (staging
kept reporting the old commit) and Render deploy logs.

### Timeline

| Time | Event |
| --- | --- |
| 00:17 (approx.) | Commit `a48b74c` (OpenTelemetry) passes CI |
| 00:23:31 | Staging build starts and succeeds |
| 00:24:25 | New instance crashes at start: `TypeError: Invalid URL`, input `otlp-gateway-prod-us-east-6.grafana.net/otlp` |
| 00:24:30 | Render: "Exited with status 1"; health check never passes, **previous version keeps serving** |
| later | Endpoint corrected to `https://…/otlp`; hardening commit `08f9a17` deployed |

### Cause

`OTEL_EXPORTER_OTLP_ENDPOINT` was entered without `https://`. Our telemetry bootstrap
called `new URL(endpoint)` (only to log the host) without handling the error, so a
monitoring setting stopped the whole server from starting.

### Impact

None for users: Render only switches traffic after `/healthz` passes, so staging stayed
on the previous version. Production unaffected (deploys only via Promote).

### Actions (done)

1. Telemetry validates its endpoint and catches SDK start-up failures; a bad config now
   logs `OpenTelemetry DISABLED …` and the app runs (commit `08f9a17`).
2. Regression test with the exact bad value (`tests/telemetry.test.ts`).
3. Lesson recorded: observability must fail open, never take the service down.

---

## Game Day, 2026-11-23: deliberate outage of staging

**Hypothesis:** if the staging API becomes unavailable, (1) the frontend shows its
error states with retry, (2) the Grafana availability alert on `/healthz` fires and
notifies within minutes, (3) production is unaffected, (4) recovery is a single action
and the alert resolves.

**Method:** suspend `trivianerd-api-staging` in Render, observe, resume. Observed by
three independent sources:
* the student's notes and screenshots (taken in local time, UTC−5, converted here);
* Grafana Synthetic Monitoring (check `trivianerd-staging-healthz`: 2 probes, every
  2 min, must return 200);
* an outside logger polling staging and production `/healthz` every 15 s.

### Timeline (UTC)

| Time | Source | Observation |
| --- | --- | --- |
| 03:35:01 | logger | staging 200 `{"status":"ok"}`, production 200 |
| 03:37 | student | **Staging web service suspended** in Render |
| 03:37:22 | logger | staging returns **503** (Render's "service suspended" HTML page) |
| 03:37 | screenshot | staging frontend shows error states with **Retry**: "Sign-in unavailable: Could not reach the sign-in server", "Couldn't load trivia questions. Could not reach the trivia server." (both panels), live leaderboard "Reconnecting…" |
| 03:38 | student | failure noted |
| 03:44 | Grafana | **alert email received**: about 7 min after the outage began |
| 03:45 | student | **Service resumed** in Render (one action) |
| 03:46:36–03:47:28 | logger | requests time out (10 s) while the instance starts |
| 03:47:39 | `/healthz` | new instance `startedAt` |
| 03:47:53 | logger | staging **200** `{"status":"ok"}`, database ok |
| 03:37–03:48 | logger | production **40/40 checks 200** throughout |
| 03:59 | Grafana | **"resolved" email received**, about 11 min after staging was healthy again |

User-visible outage on staging: **03:37:22 → 03:47:53, about 10½ minutes**. Detection
took about 7 minutes. Recovery took about 3 minutes after the resume click: the
instance's start-up, then the health gate.

### Results against the hypothesis

1. **Frontend error states: held.** Every part of the page failed visibly and
   recoverably, with no blank screen or crash (screenshot, 03:37 UTC):
   * sign-in reported "Could not reach the sign-in server" with **Retry**;
   * the question panels said "Couldn't load trivia questions" with **Retry**;
   * the live leaderboard showed **Reconnecting…**.

   The leaderboard stream is built to reconnect by itself (F11, shown separately
   in the kill-and-recover demo); the other panels recover on Retry. Recovery of the
   page itself was not screenshotted during this exercise.
2. **Alert fired and notified: held, but slowly.** The email arrived about 7 minutes
   after the outage began. The delay comes mainly from the 2-minute check interval and
   the rule's 5-minute window of failed runs. The alert was
   configured for a cheap free-tier budget, not for fast detection.
3. **Production unaffected: held.** 40/40 production checks returned 200 during the
   window. Staging and production share no runtime resources.
4. **Single-action recovery: held; alert resolution: held, but late.** Resume brought
   the service back in about 3 minutes with no other steps. The new instance reported
   the same commit (`f64d7a9`) and a healthy database. The "resolved" email followed at
   03:59, about 11 minutes after recovery. The alert only clears once its 5-minute
   window is free of failed runs, and Grafana sends notifications in batches. So for
   a while the alert channel lagged reality, and `/healthz` was the faster source of
   truth.

### What we learned / actions

* **Detection time is a configuration choice.** For production, a 1-minute interval
  with a 3-minute window would cut detection to roughly 3–4 minutes. That costs about
  twice the check executions (see `cost.md`; the free tier still covers one such
  check). Recommended action: add a production check (none exists yet) at a 1-minute
  interval; staging can stay at 2 minutes.
* **Start-up is part of the outage.** About 1 minute of timeouts came after the resume
  click, before the health gate passed. Action: runbook §1 now states the measured
  ~3-minute recovery after a resume or restart, so on-call does not act too early.
* The alert email and the "suspended" 503 page are both distinguishable from an
  application failure (503 from `/healthz` carries a JSON body). This tells an
  on-call person whether the platform or the app is at fault.

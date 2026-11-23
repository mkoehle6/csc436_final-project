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

## Game Day, 2026-11-23: deliberate outage of staging (to be completed after the exercise)

**Hypothesis:** if the staging API becomes unavailable, (1) the frontend shows its
error states with retry, (2) the Grafana availability alert on `/healthz` fires and
notifies within minutes, (3) production is unaffected, (4) recovery is a single action
and the alert resolves.

**Method:** suspend `trivianerd-api-staging` in Render, observe, resume.

| Time | Observation |
| --- | --- |
| _tbd_ | _filled in during the exercise, with alert and screenshot references_ |

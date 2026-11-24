# D10: observability (logs, metrics, cross-component trace, SLO alert that fired)

**Stack:** OpenTelemetry Node SDK in the backend (`backend/src/telemetry.ts`, loaded
with `node --import ./dist/telemetry.js`), exporting traces, metrics and logs over
OTLP/HTTP to **Grafana Cloud** (Tempo, Prometheus/Mimir, Loki). Grafana **Synthetic
Monitoring** checks `/healthz` from outside. The service is `trivianerd-api`;
`service.version` is the deployed commit. Telemetry fails open: a bad configuration
logs `OpenTelemetry DISABLED …` and the app keeps running (incident 2 in
`postmortems.md`).

## Signals

| Signal | What | Evidence |
| --- | --- | --- |
| **Traces** | HTTP server spans (Express), outgoing HTTP (Simpsons API), PostgreSQL queries (`pg`) | Tempo screenshot: `GET /api/questions` on staging with child `pg.query` spans to Render Postgres (`db.system.name=postgresql`, `server.address=dpg-…`), `service.version=08f9a17`. This is the **cross-component trace**: app → database |
| **Logs** | pino request and app logs exported to Loki; each line carries `trace_id`/`span_id`, so a log line links to its trace. `Authorization`, `Cookie` and `Set-Cookie` are redacted | Loki screenshot (Explore → `{service_name="trivianerd-api"}`): 676 lines in the last hour, common label `deployment_environment_name=staging`; an expanded `request completed` line shows the field **`traceID` = `ac59d3c13569fedc5782559d9ae4adf0`**, the key that links the log line to its trace in Tempo. Also verified earlier with a local OTLP receiver. |
| **Metrics** | auto-instrumented HTTP server duration; custom counters `trivianerd.answers` (channel, correct), `trivianerd.simpsons_api.calls` (outcome), `trivianerd.question_bank.top_ups` (result) in `backend/src/lib/metrics.ts`. Synthetic Monitoring adds `probe_success`, latency and TLS expiry | synthetic check dashboard screenshot; custom-metric screenshot (Explore → `grafanacloud-…-prom` → `sum by (correct) (trivianerd_answers_total)`): after the student answered questions while signed in on staging, the `correct="true"` series rose from 2 to 7 within about a minute (30-second export interval). The OTel name `trivianerd.answers` appears in Prometheus as `trivianerd_answers_total`. A dashboard would plot `rate(...)`; the raw count is shown here because it can be checked against the answers given. |

## SLO

Defined in Grafana Cloud SLO (Alerts & IRM → SLO):

| Field | Value |
| --- | --- |
| Name | TriviaNerd staging availability |
| SLI | ratio of successful synthetic checks: `probe_all_success_sum` / `probe_all_success_count` for job `trivianerd-staging-healthz` (2 probes, every 2 min, `GET /healthz` must return 200) |
| Target | **99.5%** over a rolling **7-day** window (error budget 0.5% ≈ 50 min/week) |
| Alerts | Grafana-generated multi-window burn-rate rules: **"Error Budget Burn Rate is Very High"** (fast burn) and **"…is High"** (slow burn), routed to the email contact point |

Staging is the SLO target because it is the environment we can break on purpose.
Production is **not** yet under a synthetic check: during both outage tests it was
watched by the outside logger only (see Limits).

## The SLO alert firing (deliberate test, 2026-11-23)

Method: suspend `trivianerd-api-staging` in Render, watch, resume. This is the same
method as the Game Day, run again after the SLO existed. Outside logger:
`d10-slo-test-healthz-log.txt`.

| UTC (local = UTC−5) | Source | Observation |
| --- | --- | --- |
| before 20:37 | student | SLO created; its recording rules start (13 shown) |
| 20:37 | student | staging suspended |
| 20:37:06 | logger | staging **503** (Render "suspended" page); production 200 |
| 20:44 | Grafana email | **`ProbeFailedExecutionsTooHigh [5m]` Firing**: "Check job:trivianerd-staging-healthz … has failed 2 times in the last 5m" (`executions=2 threshold=2`, check frequency 120000 ms) (screenshot) |
| ~20:51 | Grafana SLO page | SLI 50.00% (5 of 10 events failed), error budget **−9900%**, target 99.50% |
| ~20:52 | Grafana Alert rules | **both burn-rate alerts Firing** ("Very High" and "High"); screenshot |
| 20:52:32 | logger | staging not answering (10 s timeouts) while resuming |
| 20:53 | student | staging resumed |
| 20:53:30 / 20:53:48 | `/healthz` / logger | new instance started; staging **200**, database ok |
| 20:37–20:53 | logger | production **63/63 checks 200** |
| 21:04 | Grafana email | **`ProbeFailedExecutionsTooHigh [5m]` Resolved** ("failed 1 times in the last 5m", below the threshold of 2), about 11 min after staging was healthy again (screenshot) |

### Interpretation

* **Why both alerts fired so fast:** with a 99.5% target, the budget allows 0.5%
  failures. A total outage fails 100% of checks, a **burn rate of ~200×** against the
  budget (100% / 0.5%). The fast-burn rule fires at roughly 14× over its short and
  long windows. The SLO was only minutes old, so the long window contained mostly
  outage data. The "−9900%" budget means the outage spent the week's budget about 100
  times over, within the SLO's short history.
* **Resolution lags recovery:** the availability alert resolved 11 minutes after
  staging was back. That is the same lag as in the Game Day: the 5-minute window must
  drain of failures, plus evaluation and notification batching. During that time
  `/healthz` was the faster source of truth.
* **Alert ordering:** the simple availability alert (fixed threshold on failed
  checks) emailed at 20:44. The SLO alerts were Firing by ~20:52. The two layers answer
  different questions: "is it down now?" and "are we breaking our promise?".
* **Expected side effect:** the 7-day SLI stays below target until this test ages out
  of the window. That is correct behaviour, recorded here so it is not mistaken for a
  real incident.

## Other alerts

* **Certificate expiry** (`SyntheticCheckTLSExpiryBreach`): threshold temporarily set
  to 100 days so it would fire against the ~88 days remaining. It fired and the email
  arrived (screenshots), then it was set back to 14 days.
* **Availability**: Grafana's per-check rule `ProbeFailedExecutionsTooHigh [5m]`, which
  fires when the check fails **2 times within 5 minutes** (with one run every 2 minutes,
  that is about 2–4 minutes of outage). It fired in the Game Day (`postmortems.md`)
  and in this test (email screenshot, 3:44 PM local).

## Limits

* **Only staging is monitored by Grafana** (one synthetic check, its alerts and the
  SLO), because it is the environment we break on purpose. Production has telemetry
  (traces, logs, metrics) but no synthetic check, availability alert or SLO yet. The
  next step is to clone the staging check for `https://trivia-api.burnscodev.com/healthz`
  (1-minute interval, as recommended in the Game Day) with the same alerts.
* The SLO measures availability from 2 probe locations every 2 minutes. Shorter
  outages can fall between checks, and latency is not part of the SLI.

## Screenshots

* [`d10-tempo-trace-api-to-postgres.png`](screenshots/d10-tempo-trace-api-to-postgres.png)
* [`d10-loki-log-with-traceid.png`](screenshots/d10-loki-log-with-traceid.png)
* [`d10-metric-answers-total.png`](screenshots/d10-metric-answers-total.png)
* [`d10-synthetic-check-up.png`](screenshots/d10-synthetic-check-up.png)
* [`d10-slo-overview.png`](screenshots/d10-slo-overview.png)
* [`d10-slo-burn-rate-alerts-firing.png`](screenshots/d10-slo-burn-rate-alerts-firing.png)
* [`d10-availability-alert-email-firing.png`](screenshots/d10-availability-alert-email-firing.png)
* [`d10-availability-alert-email-resolved.png`](screenshots/d10-availability-alert-email-resolved.png)

(Index with descriptions: `screenshots/README.md`.)

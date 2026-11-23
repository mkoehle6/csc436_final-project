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
| **Logs** | pino request and app logs exported to Loki; each line carries `trace_id`/`span_id`, so a log line links to its trace. `Authorization`, `Cookie` and `Set-Cookie` are redacted | verified with a local OTLP receiver (log records carried `trace_id`); Loki screenshot: _student to add (Explore → Loki → `service_name="trivianerd-api"`)_ |
| **Metrics** | auto-instrumented HTTP server duration; custom counters `trivianerd.answers` (channel, correct), `trivianerd.simpsons_api.calls` (outcome), `trivianerd.question_bank.top_ups` (result) in `backend/src/lib/metrics.ts`. Synthetic Monitoring adds `probe_success`, latency and TLS expiry | synthetic check dashboard screenshot; custom-metric screenshot: _student to add (Explore → Prometheus → `trivianerd_answers_total`)_ |

## SLO

Defined in Grafana Cloud SLO (Alerts & IRM → SLO):

| Field | Value |
| --- | --- |
| Name | TriviaNerd staging availability |
| SLI | ratio of successful synthetic checks: `probe_all_success_sum` / `probe_all_success_count` for job `trivianerd-staging-healthz` (2 probes, every 2 min, `GET /healthz` must return 200) |
| Target | **99.5%** over a rolling **7-day** window (error budget 0.5% ≈ 50 min/week) |
| Alerts | Grafana-generated multi-window burn-rate rules: **"Error Budget Burn Rate is Very High"** (fast burn) and **"…is High"** (slow burn), routed to the email contact point |

Staging is the SLO target because it is the environment we can break on purpose.
Production has the same synthetic check and availability alert.

## The SLO alert firing (deliberate test, 2026-11-23)

Method: suspend `trivianerd-api-staging` in Render, watch, resume. This is the same
method as the Game Day, run again after the SLO existed. Outside logger:
`d10-slo-test-healthz-log.txt`.

| UTC (local = UTC−5) | Source | Observation |
| --- | --- | --- |
| before 20:37 | student | SLO created; its recording rules start (13 shown) |
| 20:37 | student | staging suspended |
| 20:37:06 | logger | staging **503** (Render "suspended" page); production 200 |
| 20:44 | Grafana email | availability alert (synthetic check failures) |
| ~20:51 | Grafana SLO page | SLI 50.00% (5 of 10 events failed), error budget **−9900%**, target 99.50% |
| ~20:52 | Grafana Alert rules | **both burn-rate alerts Firing** ("Very High" and "High"); screenshot |
| 20:52:32 | logger | staging not answering (10 s timeouts) while resuming |
| 20:53 | student | staging resumed |
| 20:53:30 / 20:53:48 | `/healthz` / logger | new instance started; staging **200**, database ok |
| 20:37–20:53 | logger | production **63/63 checks 200** |

### Interpretation

* **Why both alerts fired so fast:** with a 99.5% target, the budget allows 0.5%
  failures. A total outage fails 100% of checks, a **burn rate of ~200×** against the
  budget (100% / 0.5%). The fast-burn rule fires at roughly 14× over its short and
  long windows. The SLO was only minutes old, so the long window contained mostly
  outage data. The "−9900%" budget means the outage spent the week's budget about 100
  times over, within the SLO's short history.
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
* **Availability** (synthetic check failed executions): fired in the Game Day
  (`postmortems.md`) and in this test.

## Limits

* The SLO is on staging (free instance) for safe testing; production has the check
  and availability alert but no SLO of its own.
* The SLO measures availability from 2 probe locations every 2 minutes. Shorter
  outages can fall between checks, and latency is not part of the SLI.

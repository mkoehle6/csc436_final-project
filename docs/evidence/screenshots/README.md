# Screenshots (index)

Taken by the student during the project, 2026-11-22/23. Personal data was removed
before committing: the consent screens' "Signed in as …" line (black box), and the
Game Day screenshot's taskbar (cropped). The Render workspace-settings screenshot was
**left out** because it shows an email address. The MCP host recording (179 MB) is
submitted separately (see `../f12-f13-mcp.md`).

| Requirement | File | Shows |
| --- | --- | --- |
| F12 | `f12-inspector-step-up-insufficient-scope.png` | MCP Inspector: `add_question` with a read-only token → 403 `insufficient_scope` → "Additional permissions required: questions:write" step-up dialog |
| F12 / F9 | `f12-consent-viewer-role-capped.png` | consent screen for a **viewer**: `questions:write` struck through, "not available for your role" |
| F12 / F9 | `f12-consent-operator.png` | consent screen for an **operator**: `questions:write` offered |
| D1 / D2 / D6 | `d1-d2-d6-cloudflare-dns-records.png` | Cloudflare DNS: CAA ×3 (one CA each); frontends **Proxied**, APIs **DNS only**; TTL Auto |
| D2 | `d2-synthetic-check-ssl-expiry.png` | synthetic check page: SSL expiry 12.57 weeks (taken while the check was still misconfigured, so uptime shows 0%) |
| D2 | `d2-tls-expiry-alert-firing.png` | `SyntheticCheckTLSExpiryBreach` **Firing** (threshold temporarily 100 days) |
| D2 | `d2-tls-expiry-alert-email.png` | email: `TLSTargetCertificateCloseToExpiring` Firing (2 instances = 2 probes), "will expire in 88 days" (`A=87.96`), Sun 11/22 10:09 PM |
| D4 | `d4-render-rollback.png` | Render deploy "Rolled back by you via Dashboard", source `f64d7a9`, no build step, waiting for `/healthz` |
| D4 | `d4-render-roll-forward.png` | Render deploy "Manually deployed by you via Dashboard", source `b7f6595`, full build |
| D4 / D3 | `d4-promote-runs.png` | GitHub Actions: 12 successful "Promote to production" runs |
| D4 / D3 | `d4-promote-12-summary.png` | Promote #12 summary: backend `f64d7a9`→`0dfba4c` (76 s), frontend `a48b74c`→`0dfba4c` (45 s) |
| D4 | `d4-ci-runs.png` | GitHub Actions: CI runs, all green |
| D10 | `d10-tempo-trace-api-to-postgres.png` | Tempo trace: `trivianerd-api` → `pg.query` on Render Postgres, `service.version` 08f9a17 |
| D10 | `d10-loki-log-with-traceid.png` | Loki: `request completed` log line with `traceID` |
| D10 | `d10-metric-answers-total.png` | Prometheus: `sum by (correct) (trivianerd_answers_total)` rising 2 → 7 |
| D10 | `d10-synthetic-check-up.png` | Synthetics overview: staging `/healthz` check **UP**, 100% reachability |
| D10 | `d10-slo-overview.png` | SLO "TriviaNerd staging availability": SLI 50%, target 99.5%, budget −9900% during the test |
| D10 | `d10-slo-burn-rate-alerts-firing.png` | both burn-rate alerts ("High", "Very High") **Firing** |
| D10 / S2 | `d10-availability-alert-email-firing.png` | email: `ProbeFailedExecutionsTooHigh [5m]` Firing, 3:44 PM |
| D10 / S2 | `d10-availability-alert-email-resolved.png` | email: same alert Resolved, 4:04 PM |
| D11 | `d11-build-pipeline-spend-limit.png` | Render Build Pipeline: Starter, 500 free minutes, **$0 monthly spend limit** |
| S2 / F2 | `s2-gameday-frontend-error-states.png` | Game Day: staging frontend with sign-in, questions and leaderboard error/retry states |

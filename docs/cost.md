# Cost analysis (D11)

All figures USD per month. Prices are list prices at the time of writing; lines marked
**verify** must be checked against the provider's billing page (and the screenshot kept
as evidence) before submission.

## Current bill (1×)

| Item | Plan | Monthly | Source |
| --- | --- | --- | --- |
| Production backend | Render web service `0.5c-512mb` ("Starter") | 7.00 | Render pricing (**verify**) |
| Production database | Render Postgres `0.1c-256mb` + storage | ~6.00 + storage | Render pricing (**verify**; storage billed per GB) |
| Staging backend | Render free instance | 0.00 | free tier: 750 instance-hours/month per workspace, sleeps after 15 min idle |
| Staging database | Render free Postgres | 0.00 | expires 30 days after creation (runbook §3) |
| Frontends (×2) | Render static sites | 0.00 | static sites are free |
| Builds | Render build pipeline "Starter" (2 CPU, 8 GB) | 0.00 | 500 free build minutes/month included, then $5 per 1,000 min; **spend limit set to $0** (screenshot), so overage is impossible |
| Workspace | Render **Hobby** plan | 0.00 | workspace fee; services are billed separately |
| Custom domains beyond 2 included | 2 × $0.25 | 0.50 | Render dashboard ("2/2 included, $0.25/month each") |
| Domain `burnscodev.com` | Porkbun .com renewal ≈ $11/yr | ~0.92 | Porkbun (**verify**) |
| DNS + DNSSEC | Cloudflare Free | 0.00 | |
| Observability | Grafana Cloud Free | 0.00 | free tier limits (metrics series, logs/traces GB) |
| Google OAuth, The Simpsons API, GitHub Actions | free | 0.00 | public repo minutes not needed; private repo within free minutes |
| **Total** | | **≈ $14.42 + DB storage** | |

## Traffic model

Assumption for 1×: a class-sized audience of **50 active users/day**, each loading the
site once and playing 2 rounds.

| Per user-day | Requests |
| --- | --- |
| Page + assets (assets cached 1 year after first visit) | ~3 |
| Token refresh, questions, leaderboard | ~4 |
| Answers (2 rounds × 9) | 18 |
| Live leaderboard stream (1 long-lived request) | 1 |
| **Total** | **~26 requests** |

* 1×: 50 × 26 = **1,300 requests/day** ≈ 39,000/month ≈ 0.015 req/s average.
* 10×: 500 users/day → 13,000/day ≈ 390,000/month ≈ 0.15 req/s.
* 100×: 5,000 users/day → 130,000/day ≈ 3.9 M/month ≈ 1.5 req/s average; assume
  peak = 10 × average ≈ **15 req/s**, and ~200 concurrent SSE connections at peak.

Data volume: answers are ~200 bytes each in Postgres; at 100× that is 5,000 × 18 × 30 ×
200 B ≈ **540 MB/month** of answers (plus audit rows of similar size) → storage grows
~1 GB/month at 100×, negligible at 1×.

Bandwidth: first visit ~75 KB gzipped (JS) + API JSON (~2 KB per call): 1× ≈ 50 ×
(75 + 23×2) KB ≈ 6 MB/day ≈ 0.2 GB/month; 100× ≈ 18 GB/month.

## Cost at 1×, 10×, 100×

| Component | 1× | 10× | 100× | Reasoning |
| --- | --- | --- | --- | --- |
| Production backend | 7.00 | 7.00 | 25.00 | 0.5 CPU handles 0.15 req/s easily; at 15 req/s peak and ~200 SSE streams (cap is 200/instance today) move to `1c-2g` (~$25, **verify**) |
| Production database | ~6 | ~6 | ~20 | 256 MB RAM is fine for MBs of data; at ~1 GB/month growth and more connections, step up one plan (**verify**) |
| DB storage | ~0.3 | ~0.3 | ~3 | 1 GB → 10 GB after a year at 100× (**verify** per-GB price) |
| Staging (backend + DB) | 0 | 0 | 0–13 | free tier is enough for testing; at 100× an always-on staging that mirrors prod may be worth ~$13 |
| Domains + extra custom domains | 1.42 | 1.42 | 1.42 | fixed |
| Grafana Cloud | 0 | 0 | 0–19 | free tier covers 1× and 10×; at 100× traces may exceed free GB → sample traces (e.g. 10%) to stay free, or pay |
| Bandwidth | 0 | 0 | 0 | 18 GB/month is within Render's included bandwidth (**verify** the Hobby allowance) |
| **Total (approx.)** | **≈ $15** | **≈ $15** | **≈ $50–80** | |

**Observation:** cost is flat from 1× to 10× because the bill is dominated by fixed
minimum instance sizes, not usage. The first real step is at 100×, driven by peak
concurrency (SSE streams and request latency), not storage or bandwidth.

## Budget controls (D11)

| Cost | Control | Type |
| --- | --- | --- |
| Build minutes | Render Workspace settings → Build Pipeline: **$0 monthly spend limit** ("If you reach this limit and run out of minutes, builds and other pre-deploy tasks stop running") | **hard cap** (screenshot) |
| Production compute + database | fixed instance types in `render.yaml` (`plan:`); any change is a reviewed commit plus a deliberate Blueprint Manual Sync | fixed price, change-controlled |
| Staging, static sites, DNS, Grafana | free tiers; exceeding them stops or degrades the service, it does not bill | capped by plan |
| Bandwidth beyond the Hobby allowance | not capped | **monitored**: monthly invoice check (runbook §9); 100× estimate is ~18 GB/month |

**Effect of the $0 build cap:** each deploy uses a few build minutes (shown per
deploy in Render), so 500 minutes cover a normal month of deploys. If they ran out, deploys would stop
but the running versions would keep serving. The fix is to raise the limit or wait
for the next month; see runbook §9.

The only spend setting found in the Render Hobby workspace is this build cap; there is
no "alert me at $X" budget for compute. The **hard cap** on the one usage-billed item (builds) plus **fixed-price** instances
make the monthly bill predictable: a surprise charge needs a plan change, and plan
changes go through `render.yaml` review.

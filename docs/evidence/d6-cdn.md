# D6: CDN (Cloudflare proxy) for the frontend

**Scope:** the frontend hosts only. `trivia-staging.burnscodev.com`, then
`trivia.burnscodev.com` after staging proved out, are proxied through
our Cloudflare zone (orange cloud) with SSL/TLS mode **Full (strict)**: Cloudflare
connects to Render over HTTPS and validates Render's certificate. The API hosts are
deliberately **not** proxied (honest limit; see below).

## Cache policy (set by the app, honoured by the CDN)

| Path | `Cache-Control` | CDN result | Why |
| --- | --- | --- | --- |
| `/` and other HTML | `no-cache` + ETag | `DYNAMIC` (not cached) | a new deploy must show up immediately; browsers revalidate |
| `/assets/*-<hash>.{js,css}` | `public, max-age=31536000, immutable` | cached (`MISS` → `HIT`) | file names change on every build, so a cached copy can never be stale |

## Evidence: MISS → HIT → 304 → purge → MISS → HIT

Requests go to the Cloudflare proxy address (`--resolve …:104.21.30.166`) because the
local resolver still had the pre-proxy answer cached (DNS TTL 300 s). Public resolvers
already returned Cloudflare addresses (104.21.30.166, 172.67.173.63). Captured
2026-11-23, ~04:05–04:08 UTC.

```
$ curl -sI https://trivia-staging.burnscodev.com/assets/index-DqAGYzzQ.css   # 1st request
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
cf-cache-status: MISS
etag: W/"fc17959a3937abbae3aa74db17224284"
last-modified: Mon, 23 Nov 2026 00:23:42 UTC
CF-RAY: a5ed4b676e57728a-EWR

$ curl -sI https://trivia-staging.burnscodev.com/assets/index-DqAGYzzQ.css   # 2nd request
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
cf-cache-status: HIT
etag: W/"fc17959a3937abbae3aa74db17224284"
last-modified: Mon, 23 Nov 2026 00:23:42 UTC
Age: 0
CF-RAY: a5ed4b6cedf5423e-EWR

$ curl -sI https://trivia-staging.burnscodev.com/assets/index-DqAGYzzQ.css -H 'If-None-Match: W/"fc17959a3937abbae3aa74db17224284"'   # conditional
HTTP/1.1 304 Not Modified
Cache-Control: public, max-age=31536000, immutable
cf-cache-status: HIT
etag: W/"fc17959a3937abbae3aa74db17224284"
Age: 1
last-modified: Mon, 23 Nov 2026 00:23:42 UTC
CF-RAY: a5ed4b712d5ee222-EWR

$ curl -sI https://trivia-staging.burnscodev.com/assets/index-DqAGYzzQ.css   # after purge
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
Age: 190
etag: W/"fc17959a3937abbae3aa74db17224284"
cf-cache-status: MISS
CF-RAY: a5ed5010c9afc94d-EWR

$ curl -sI https://trivia-staging.burnscodev.com/assets/index-DqAGYzzQ.css   # again
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
Age: 0
etag: W/"fc17959a3937abbae3aa74db17224284"
cf-cache-status: HIT
CF-RAY: a5ed5011f84aff90-EWR

```

The purge in between was done in Cloudflare (Caching → Configuration → Custom Purge →
URL, screenshot kept) for exactly that asset URL.

### Reading the results

* **MISS → HIT:** the first request filled our edge cache, and the second was served
  from it.
* **304 Not Modified:** a conditional request (`If-None-Match` with the ETag) was
  answered by the edge with no body.
* **Purge → MISS → HIT:** after the purge, the edge fetched the file from Render again,
  then cached it again.
* **Two cache layers:** the `Age: 190` on the post-purge MISS comes from **Render's own
  edge cache**, which is also Cloudflare-based, in front of the static site. Our purge
  clears **our** layer, and Render's layer is cleared by Render on every deploy. That is
  safe here because asset names are content-hashed: a deploy produces new URLs, so
  neither layer can serve an old asset for a new page.

## Honest limits

* **API not behind the CDN.** The API's answers are per-user or must be fresh
  (questions are `no-store`; `/api/leaderboard` is only briefly cacheable). The live
  leaderboard is a long-lived SSE stream that a proxy could buffer. The rate limiter
  also trusts a fixed number of proxy hops (`TRUST_PROXY`) to find the real client
  address. Adding Cloudflare in front of the API would change that count and needs a
  matching config change, so it is out of scope.

## Production (proxied after staging was verified, 2026-11-23T04:11Z)

Staging was checked by hand first: the student signed in and used the app behind the
proxy and reported it working. Then `trivia` was switched to Proxied.

```
public A for trivia.burnscodev.com: 104.21.30.166, 172.67.173.63   (Cloudflare proxy)
GET /                        200  Cache-Control: no-cache  cf-cache-status: DYNAMIC
                                  CSP, X-Frame-Options DENY, HSTS intact
GET /assets/index-fEQ2YNmA.js  200  cf-cache-status: MISS
GET /assets/index-fEQ2YNmA.js  200  cf-cache-status: HIT
TLS: CN=trivia.burnscodev.com, issuer Google Trust Services WE1, valid to 2027-02-19
trivia-api.burnscodev.com/healthz  200 from 216.24.57.18 (Render direct, not proxied)
```

## Screenshots

* [`d1-d2-d6-cloudflare-dns-records.png`](screenshots/d1-d2-d6-cloudflare-dns-records.png)

(Index with descriptions: `screenshots/README.md`.)

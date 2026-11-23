# D2: HTTPS (certificates, redirects, HSTS, CAA, expiry monitoring)

All four hosts are HTTPS-only. Render issues and renews the certificates automatically
for each custom domain; the frontends are additionally proxied through our Cloudflare
zone with SSL mode **Full (strict)** (D6). Checked from outside on 2026-11-23 ~21:05 UTC.

## Per host

| Host | `http://` | Certificate (issuer, expiry) | TLS 1.1 | TLS 1.2 / 1.3 | HSTS |
| --- | --- | --- | --- | --- | --- |
| `trivia` (prod frontend) | 301 → `https://…/` | Google Trust Services WE1, 2027-02-19 | refused | yes / yes | `max-age=31536000; includeSubDomains` |
| `trivia-staging` | 301 → `https://…/` | Google Trust Services WE1, 2027-02-19 | refused | yes / yes | `max-age=31536000; includeSubDomains` |
| `trivia-api` (prod API) | 301 → `https://…/` | Google Trust Services WE1, 2027-02-19 | refused | yes / yes | `max-age=63072000; includeSubDomains; preload` |
| `trivia-staging-api` | 301 → `https://…/` | Google Trust Services WE1, 2027-02-19 | refused | yes / yes | `max-age=63072000; includeSubDomains; preload` |

"Refused" means the server itself rejects the protocol. With the client forced to
allow TLS 1.1 (`-tls1_1 -cipher 'DEFAULT:@SECLEVEL=0'`), the server answers with alert
70, `protocol_version`:

```
$ openssl s_client -connect trivia-api.burnscodev.com:443 -servername trivia-api.burnscodev.com -tls1_1 -cipher 'DEFAULT:@SECLEVEL=0'
error:0A00042E:SSL routines:ssl3_read_bytes:tlsv1 alert protocol version ... SSL alert number 70
$ openssl s_client ... -tls1_2
New, TLSv1.2, Cipher is ECDHE-ECDSA-AES128-GCM-SHA256
```

HSTS tells browsers to use HTTPS only for this domain for 1 year (frontends) or
2 years (APIs), so even the first-hop `http://` redirect is skipped after one visit.

## CAA (which certificate authorities may issue)

Added 2026-11-23 in Cloudflare. Live answer, DNSSEC-validated (`AD=true`), identical
from the Cloudflare (1.1.1.1) and Google (8.8.8.8) resolvers:

```
burnscodev.com. 3600 CAA 0 issue "comodoca.com"
burnscodev.com. 3600 CAA 0 issue "digicert.com; cansignhttpexchanges=yes"
burnscodev.com. 3600 CAA 0 issue "letsencrypt.org"
burnscodev.com. 3600 CAA 0 issue "pki.goog; cansignhttpexchanges=yes"
burnscodev.com. 3600 CAA 0 issue "ssl.com"
(+ the same five as issuewild)
```

* **Our records:** `pki.goog` (Google Trust Services, the current issuer) and
  `letsencrypt.org` (Render's other CA). These cover Render's certificate renewals.
* **Cloudflare adds its own CAs** (`ssl.com`, `digicert.com`, `comodoca.com`)
  automatically once a zone has CAA records, so its edge certificates for the
  proxied frontends keep renewing.
* Any other CA must refuse to issue a certificate for `burnscodev.com` or its
  subdomains.
* **Mistake caught on the way:** the first attempt put three CAs into one record
  (`issue "pki.goog, letsencrypt.org, ssl.com"`). A CAA value names exactly **one**
  issuer (RFC 8659), so CAs would treat that record as malformed. It was split into
  one record per CA and re-verified (the output above).

## Expiry monitoring (alert that fired)

Grafana Synthetic Monitoring checks the certificate of each monitored `/healthz` host
on every run (staging check: the `SSL Expiry` panel showed **12.57 weeks** ≈ 88 days).
All four certificates come from the same issuer with the same lifetime (table above),
so one monitored host is representative. The alert
**`SyntheticCheckTLSExpiryBreach`** was set to 100 days so that it would fire. It
showed **Firing**, the email arrived (screenshots), and the threshold was then set
back to **14 days**. Renewal is automatic, so a certificate with under 14 days left
means renewal has failed: check the custom domain's status in the Render dashboard
(and that the CAA records still allow the issuer).

## Limits

* Certificate issuance and renewal are Render's (and, for the proxied hosts,
  Cloudflare's). We monitor them; we do not run them.
* The CAA set includes Cloudflare's CAs, which we did not choose individually;
  Cloudflare adds them automatically for its proxied hosts.

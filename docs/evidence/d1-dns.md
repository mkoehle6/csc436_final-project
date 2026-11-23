# D1: DNS records, TTLs, delegation and DNSSEC

Zone `burnscodev.com`: registrar Porkbun, DNS hosted on Cloudflare (free plan) with
DNSSEC. Zone exported from Cloudflare 2026-11-23 02:16 UTC; live checks run
2026-11-23 ~02:20 UTC. Cloudflare shows TTL `1` in the export, which means **Auto**:
it is served as 300 s for DNS-only records (see the live answers below).

## Records

| Name | Type | TTL served | Value | Purpose |
| --- | --- | --- | --- | --- |
| `burnscodev.com` | SOA | 3600 | `eleanor.ns.cloudflare.com.` … minimum 3600 | zone authority; the last field is the negative-caching TTL |
| `burnscodev.com` | NS | 86400 | `eleanor.ns.cloudflare.com`, `kyree.ns.cloudflare.com` | Cloudflare nameservers (also set at Porkbun) |
| `trivia` | CNAME | 300 | `trivianerd-web-prod.onrender.com` | production frontend (Render static site) |
| `trivia-api` | CNAME | 300 | `trivianerd-api-prod.onrender.com` | production API |
| `trivia-staging` | CNAME | 300 | `trivianerd-web-staging.onrender.com` | staging frontend |
| `trivia-staging-api` | CNAME | 300 | `trivianerd-api-staging.onrender.com` | staging API |
| `burnscodev.com` | TXT | 300 | `CSC436-2026FALL-8D4F71A9C2B63E55` | course domain-ownership marker |
| `burnscodev.com` | TXT | 300 | `v=spf1 -all` | no host may send mail as this domain |
| `_dmarc` | TXT | 300 | `v=DMARC1; p=reject; …` | reject spoofed mail |
| `*._domainkey` | TXT | 300 | `v=DKIM1; p=` | null DKIM key: no valid signatures exist |
| `_acme-challenge` | TXT ×2 | 300 | (challenge tokens) | leftover certificate-validation records (see findings) |

At export time all four CNAMEs were **DNS-only** (`cf-proxied:false`). **Update
2026-11-23 04:11 UTC:** the two frontend records (`trivia`, `trivia-staging`) are now
**Proxied** through Cloudflare for D6 (see `d6-cdn.md`), so public resolvers return
Cloudflare addresses for them; the two API records stay DNS-only. Render terminates TLS and
issues the certificates (issuer observed: Google Trust Services `WE1`, valid until
2027-02-19).

## TTL rationale

* **App CNAMEs: 300 s (Auto).** These are the records we might change in an
  incident: for example, pointing a host at another service or turning on the
  Cloudflare proxy (D6). Five minutes bounds how long stale answers live after a
  change. The cost is a little more resolver traffic, which is negligible. There is
  no need to lower TTLs before a planned change, because they are already short.
* **NS: 86400 s; delegation at `.com`: 172800 s (set by the registry).** Nameservers
  change almost never, so long caching is appropriate. A provider move would mean
  planning for up to 2 days of overlap, keeping both providers serving the same records.
* **SOA minimum: 3600 s.** This is how long a "name does not exist" answer is cached.
  So a *new* hostname that someone looked up too early can take up to an hour to
  appear. Create records before announcing them.
* **Mail-policy TXT: 300 s (Auto).** These never change, so a longer TTL (e.g. 3600)
  would also be fine; Auto is kept for simplicity.

## Delegation trace (non-recursive queries, root → TLD → authoritative)

Queried with a small UDP client (`dig +trace` is not available on this Windows
machine); each step asks one server **without recursion**:

```
; 1. a.root-servers.net (198.41.0.4): burnscodev.com NS?  -> referral to .com
authority com	172800	IN NS	l.gtld-servers.net
authority com	172800	IN NS	j.gtld-servers.net
authority com	172800	IN NS	h.gtld-servers.net
; 2. a.gtld-servers.net (192.5.6.30): burnscodev.com NS?  -> referral to Cloudflare
authority burnscodev.com	172800	IN NS	eleanor.ns.cloudflare.com
authority burnscodev.com	172800	IN NS	kyree.ns.cloudflare.com
; 3. eleanor.ns.cloudflare.com (162.159.38.205): authoritative answers
answer    trivia.burnscodev.com	300	IN CNAME	trivianerd-web-prod.onrender.com
answer    trivia-api.burnscodev.com	300	IN CNAME	trivianerd-api-prod.onrender.com
```

Full resolution through a validating resolver (Cloudflare DoH, `do=true`):

```
trivia.burnscodev.com                                  300 CNAME trivianerd-web-prod.onrender.com.
trivianerd-web-prod.onrender.com                       300 CNAME gcp-us-west1-1.origin.onrender.com.
gcp-us-west1-1.origin.onrender.com                     300 CNAME gcp-us-west1-1.origin.onrender.com.cdn.cloudflare.net.
gcp-us-west1-1.origin.onrender.com.cdn.cloudflare.net  300 A     216.24.57.16, 216.24.57.18
```

(Render's own edge runs on Cloudflare, which is why responses carry
`Server: cloudflare` even though our records are DNS-only.)

## DNSSEC

```
burnscodev.com  86400 DS      2371 13 2 3b50c449…     (in .com, signed by .com)   AD=true
burnscodev.com   3600 DNSKEY  256 3 13 … / 257 3 13 … (+ RRSIG)                AD=true
burnscodev.com    300 TXT     … (+ RRSIG by key 34505)                          AD=true
```

The DS record at `.com` (key tag 2371, algorithm 13 = ECDSA P-256/SHA-256) matches
the zone's key-signing key, and the validating resolver sets **AD (authenticated
data)** on our answers. Lookups that follow the CNAME into `onrender.com` return
`AD=false` because Render's zone is unsigned. DNSSEC protects our records, not
Render's.

## Findings

1. **Two SPF records (fixed 2026-11-23).** The export also contained
   `v=spf1 include:_spf.porkbun.com ~all`, a Porkbun default left over from the move
   to Cloudflare. RFC 7208 §4.5 allows exactly one `v=spf1` record; with two, receivers
   return `permerror` and the SPF policy is void. The domain sends no mail (no MX,
   DMARC `p=reject`, null DKIM), so the Porkbun record was deleted and `v=spf1 -all`
   kept. Verified afterwards: the authoritative server (eleanor) and the 1.1.1.1 and
   8.8.8.8 resolvers each return a single SPF record, `v=spf1 -all`, alongside the course marker.
2. **Leftover `_acme-challenge` TXT records.** These are not used by the current
   certificates. They are harmless (a validation token grants nothing by itself) and
   are left in place until confirmed unused.
3. **No CAA record at export time; added later the same day** (see `d2-https.md`).
   The original reasoning for waiting: A CAA record would limit which certificate
   authorities may issue for the domain. It is not added now: Render chooses the CA
   (currently Google Trust Services, and possibly Let's Encrypt), and a wrong CAA
   would silently break the next automatic renewal (due before 2027-02-19).

# D7: security headers and CORS, checked from outside

Generated 2026-11-23T02:06:24Z with `curl -sI`. Only security-relevant headers are shown. API sections re-captured 2026-11-23T02:33:51Z after commit `f64d7a9` reached staging and production.

## https://trivia.burnscodev.com/
```
$ curl -sI https://trivia.burnscodev.com/
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.thesimpsonsapi.com data:; connect-src 'self' https://trivia-api.burnscodev.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
permissions-policy: camera=(), microphone=(), geolocation=()
referrer-policy: strict-origin-when-cross-origin
Server: cloudflare
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
```

## https://trivia-staging.burnscodev.com/
```
$ curl -sI https://trivia-staging.burnscodev.com/
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.thesimpsonsapi.com data:; connect-src 'self' https://trivia-staging-api.burnscodev.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
permissions-policy: camera=(), microphone=(), geolocation=()
referrer-policy: strict-origin-when-cross-origin
Server: cloudflare
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
```

## https://trivia-api.burnscodev.com/healthz
```
$ curl -sI https://trivia-api.burnscodev.com/healthz
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; img-src 'self' https://cdn.thesimpsonsapi.com data:; connect-src 'self'; frame-ancestors 'none'
referrer-policy: no-referrer
Server: cloudflare
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-content-type-options: nosniff
```

## https://trivia-staging-api.burnscodev.com/healthz
```
$ curl -sI https://trivia-staging-api.burnscodev.com/healthz
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; img-src 'self' https://cdn.thesimpsonsapi.com data:; connect-src 'self'; frame-ancestors 'none'
referrer-policy: no-referrer
Server: cloudflare
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-content-type-options: nosniff
```

## CORS on trivia-api
```
$ curl -si -X OPTIONS https://trivia-api.burnscodev.com/api/questions -H 'Origin: https://trivia.burnscodev.com' -H 'Access-Control-Request-Method: POST'
HTTP/1.1 204 No Content
access-control-allow-credentials: true
access-control-allow-headers: Content-Type,Authorization
access-control-allow-methods: GET,POST,DELETE,OPTIONS
access-control-allow-origin: https://trivia.burnscodev.com

$ curl -si -X OPTIONS https://trivia-api.burnscodev.com/api/questions -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST'
HTTP/1.1 403 Forbidden

```

## CORS on trivia-staging-api
```
$ curl -si -X OPTIONS https://trivia-staging-api.burnscodev.com/api/questions -H 'Origin: https://trivia-staging.burnscodev.com' -H 'Access-Control-Request-Method: POST'
HTTP/1.1 204 No Content
access-control-allow-credentials: true
access-control-allow-headers: Content-Type,Authorization
access-control-allow-methods: GET,POST,DELETE,OPTIONS
access-control-allow-origin: https://trivia-staging.burnscodev.com

$ curl -si -X OPTIONS https://trivia-staging-api.burnscodev.com/api/questions -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST'
HTTP/1.1 403 Forbidden

```

## Findings from this check

* The first capture showed the API sending `x-powered-by: Express`, and its CSP had no
  `frame-ancestors`. Fixed in `f64d7a9` (`app.disable("x-powered-by")`,
  `frame-ancestors 'none'`) with a test in `backend/tests/health.test.ts`. A mutation
  check (removing the line) makes that test fail. The API sections above are the
  re-capture after the deploy: neither header problem remains.
* Refused preflights get `403` with **no** `Access-Control-Allow-*` headers. The MCP and
  OAuth machine endpoints are a deliberate exception: they allow `*` *without*
  credentials, because they use bearer tokens and never cookies (`backend/src/app.ts`).
* `Server: cloudflare` on every host is Render's own edge, not our Cloudflare zone.
  Our DNS records were DNS-only (grey cloud) at capture time. The frontends were later
  proxied through our zone for D6 (`d6-cdn.md`), with the same headers verified afterwards.

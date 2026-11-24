# TriviaNerd architecture (Q2)

Diagrams are Mermaid (rendered by GitHub). Commit at time of writing: see `git log`.

## 1. Request path

Browser → DNS → CDN → app → database / third parties.

```mermaid
flowchart LR
  subgraph Clients
    B["Browser<br/>React SPA"]
    M["MCP host<br/>Claude / MCP Inspector"]
  end

  subgraph DNS["DNS: Cloudflare (DNSSEC), registrar Porkbun"]
    D1["trivia / trivia-staging<br/>CNAME → Render static sites"]
    D2["trivia-api / trivia-staging-api<br/>CNAME → Render web services"]
  end

  subgraph Render["Render (oregon), per environment: staging | production"]
    S["Static site + Render CDN<br/>index.html no-cache<br/>/assets/* immutable 1y"]
    API["Backend web service<br/>Express + TypeScript<br/>REST /api · SSE /api/live · OAuth /auth · MCP /mcp"]
    DB[("Render Postgres 17<br/>private network only")]
  end

  G["Google OIDC<br/>accounts.google.com"]
  SA["The Simpsons API<br/>thesimpsonsapi.com + CDN"]
  GC["Grafana Cloud<br/>OTLP: traces · metrics · logs"]

  B -- "1 DNS lookup" --> D1
  B -- "HTTPS GET page" --> S
  B -- "HTTPS fetch / EventSource" --> D2 --> API
  M -- "HTTPS Streamable HTTP + Bearer" --> API
  API -- "SQL over private network" --> DB
  API -- "HTTPS, timeout 5 s, ≤2 retries,<br/>cached, validated" --> SA
  API -- "OAuth code + PKCE exchange,<br/>ID token via JWKS" --> G
  API -- "OTLP/HTTP (async)" --> GC
  B -. "question images" .-> SA
```

**One request, end to end (e.g. `GET /api/questions`):** the browser resolves
`trivia-api.burnscodev.com` through Cloudflare DNS (CNAME to Render), opens TLS to
Render's edge (certificate issued and renewed by Render), and Render routes to the
backend instance. Middleware runs CORS (exact allowlist), security headers, rate limit,
then the route: it reads the question bank from Postgres and, only if the bank is low,
tops it up from The Simpsons API. OpenTelemetry records one trace with child spans for
each Postgres query and each outbound Simpsons API call, exported to Grafana Cloud.

## 2. Trust boundaries

```mermaid
flowchart TB
  subgraph U["UNTRUSTED: the internet"]
    B["Browser / any web page"]
    M["MCP clients<br/>identified by CIMD URL"]
    X["Attackers"]
  end

  subgraph E["Edge: Cloudflare DNS · Render TLS + routing"]
  end

  subgraph T["TRUSTED: our backend process (per environment)"]
    MW["Gatekeepers<br/>CORS allowlist · rate limits · body validation (zod)<br/>JWT verify: signature, iss, aud, exp, typ, scope, role"]
    APP["Routes / MCP tools<br/>business logic"]
    KEY[["Signing key<br/>AUTH_PRIVATE_JWK<br/>Render env only"]]
  end

  subgraph P["PRIVATE: Render private network"]
    DB[("Postgres<br/>no public access")]
  end

  subgraph TP["THIRD PARTIES: trusted for one purpose, verified"]
    G["Google: identity only<br/>ID token checked via JWKS + nonce"]
    SA["Simpsons API: data only<br/>responses schema-validated"]
    GC["Grafana Cloud: telemetry sink<br/>no user secrets sent"]
  end

  B -- "cookie (httpOnly, SameSite=Lax, /auth)<br/>+ Bearer (aud=trivianerd-api)" --> E --> MW
  M -- "Bearer (aud=…/mcp, scoped, role-capped)" --> E
  MW --> APP
  APP --> DB
  APP --> G
  APP --> SA
  APP --> GC
  KEY -. signs .-> APP
```

| Boundary | What crosses it | Control |
| --- | --- | --- |
| Internet → backend | HTTP requests from anyone | TLS only (HSTS); CORS exact-origin allowlist (`*` only on public machine endpoints, never with credentials); rate limits per class; zod validation; one JSON error shape |
| Browser session → API | httpOnly session cookie (`/auth` only) → 15-min access token | Cookie never readable by JS; token endpoint requires our Origin (CSRF); access token kept in memory only |
| MCP client → `/mcp` | Bearer token | Audience must be the MCP URL (web tokens refused, and vice versa); per-tool scopes (403 `insufficient_scope`); role re-checked per call; writes need a server-enforced confirmation code; every call audited |
| MCP client registration | Client ID Metadata Document URL | SSRF-guarded fetch (https only, non-public addresses refused after DNS, no redirects, timeout, size cap); exact `client_id` match; exact redirect-URI match; consent screen shows redirect host |
| Backend → Postgres | SQL | Private network only (`ipAllowList: []`); parameterised queries (Drizzle) |
| Backend → Google | Code + PKCE verifier + client secret | Secret only in Render env; ID token verified (JWKS, iss, aud, exp, nonce) |
| Backend → Simpsons API | Public GETs | Timeout, bounded retry, cache, single-flight + cooldown, schema validation, graceful degradation |
| Backend → Grafana | Telemetry | Token only in Render env; no tokens/cookies logged (pino redaction) |
| MCP App iframe → host | `tools/call` via postMessage | No network of its own (CSP `connect-src 'none'`); host forwards over the user's authenticated connection; server checks scope + session ownership |

## 3. Environments and delivery

```mermaid
flowchart LR
  Dev["Developer push to main"] --> CI["GitHub Actions CI<br/>validate render.yaml · typecheck · lint · test · build"]
  CI -- "checks pass" --> ST["Staging<br/>auto-deploy · /healthz gate"]
  ST -- "Promote workflow:<br/>staging healthy + CI passed + not backwards" --> PR["Production<br/>autoDeploy off · preDeploy migrations · /healthz gate"]
  BP["render.yaml change"] -. "Manual Sync only<br/>(auto-sync off after incident)" .-> ST & PR
```

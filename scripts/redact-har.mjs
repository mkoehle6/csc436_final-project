#!/usr/bin/env node
// Redacts a browser HAR of the sign-in flow so it can be published as F7 evidence.
//
//   node scripts/redact-har.mjs <raw.har> <redacted.har>
//
// Keeps only what shows the OAuth/OIDC flow's *shape*: request order, methods, hosts,
// paths, status codes, redirect targets, query-parameter *names*, and Set-Cookie
// *attributes* (HttpOnly, Secure, SameSite, Path). Removes every value that could be a
// credential or personal data: cookies, tokens, codes, state/nonce/PKCE values,
// request/response bodies, and anything from third-party hosts beyond host + path.
// Refuses to write the output if a known secret pattern survives.
import fs from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/redact-har.mjs <raw.har> <redacted.har>");
  process.exit(1);
}

const OUR_HOSTS = /(^|\.)burnscodev\.com$/;
// Query parameters whose values are public protocol settings, not secrets.
const PUBLIC_PARAMS = new Set([
  "response_type", "scope", "code_challenge_method", "client_id", "redirect_uri",
  "prompt", "access_type", "include_granted_scopes", "count", "login",
]);
// Response headers worth keeping (values are not secret).
const KEEP_HEADERS = new Set([
  "location", "content-type", "cache-control", "access-control-allow-origin",
  "access-control-allow-credentials", "strict-transport-security", "referrer-policy",
  "content-security-policy", "x-content-type-options", "www-authenticate",
]);
const R = "[REDACTED]";

function redactUrl(raw, keepQuery, base) {
  let u;
  // Relative Location headers (e.g. "/api/sessions/6") resolve against the request URL.
  try { u = new URL(raw, base); } catch { return R; }
  if (!keepQuery) return `${u.origin}${u.pathname}`;
  for (const key of [...u.searchParams.keys()]) {
    if (!PUBLIC_PARAMS.has(key)) u.searchParams.set(key, R);
  }
  u.hash = "";
  return u.toString();
}

function redactSetCookie(value) {
  // "name=value; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=…" → keep name + attributes.
  const [pair, ...attrs] = value.split(";").map((p) => p.trim());
  const name = (pair ?? "").split("=")[0];
  const kept = attrs.filter((a) => !/^expires=/i.test(a));
  return [`${name}=${R}`, ...kept].join("; ");
}

const har = JSON.parse(fs.readFileSync(input, "utf8"));
const out = { log: { version: har.log.version, creator: { name: "redacted", version: "1" }, entries: [] } };

for (const e of har.log.entries) {
  let host;
  try { host = new URL(e.request.url).hostname; } catch { continue; }
  const ours = OUR_HOSTS.test(host);
  const isDoc = /\.(js|css|png|webp|svg|ico|woff2?)$/.test(new URL(e.request.url).pathname);
  if (ours && isDoc) continue; // static assets add nothing to the auth flow

  const respHeaders = [];
  for (const h of e.response.headers ?? []) {
    const n = h.name.toLowerCase();
    if (!ours) {
      if (n === "location") respHeaders.push({ name: h.name, value: redactUrl(h.value, true, e.request.url) });
      continue;
    }
    if (n === "set-cookie") respHeaders.push({ name: h.name, value: redactSetCookie(h.value) });
    else if (n === "location") respHeaders.push({ name: h.name, value: redactUrl(h.value, true, e.request.url) });
    else if (KEEP_HEADERS.has(n)) respHeaders.push({ name: h.name, value: h.value });
  }
  const reqHeaders = [];
  if (ours) {
    for (const h of e.request.headers ?? []) {
      const n = h.name.toLowerCase();
      if (n === "authorization") reqHeaders.push({ name: h.name, value: `Bearer ${R}` });
      else if (n === "cookie") reqHeaders.push({ name: h.name, value: h.value.split(";").map((c) => `${c.split("=")[0].trim()}=${R}`).join("; ") });
      else if (n === "origin" || n === "sec-fetch-site" || n === "sec-fetch-mode") reqHeaders.push({ name: h.name, value: h.value });
    }
  }

  out.log.entries.push({
    startedDateTime: e.startedDateTime,
    request: {
      method: e.request.method,
      url: redactUrl(e.request.url, true),
      headers: reqHeaders,
    },
    response: {
      status: e.response.status,
      statusText: e.response.statusText,
      headers: respHeaders,
      // Bodies are dropped: they hold tokens (/auth/token) and personal data.
      content: { mimeType: e.response.content?.mimeType ?? "", size: e.response.content?.size ?? 0, text: undefined },
    },
    ...(ours ? {} : { note: "third-party host: only host, path and status kept" }),
  });
}

const text = JSON.stringify(out, null, 2);
// Last line of defence: refuse to write if anything credential-shaped survived.
const forbidden = [
  [/eyJ[A-Za-z0-9_-]{10,}/, "JWT"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i, "email address"],
  [/GOCSPX-/, "Google client secret"],
  [/ya29\.|1\/\/0|4\/0[A-Za-z0-9_-]/, "Google token or code"],
  [/(SID|HSID|SSID|APISID|SAPISID|__Secure-[0-9A-Z]+PSID)=(?!\[REDACTED\])/, "Google session cookie"],
];
for (const [re, what] of forbidden) {
  if (re.test(text)) {
    console.error(`Refusing to write: output still contains something that looks like a ${what}.`);
    process.exit(2);
  }
}
fs.writeFileSync(output, text);
console.log(`Wrote ${out.log.entries.length} entries to ${output} (from ${har.log.entries.length}).`);

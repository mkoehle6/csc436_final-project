import { randomBytes } from "node:crypto";
import type { Response } from "express";
import { SCOPE_DESCRIPTIONS } from "../auth/scopes.js";

/**
 * Server-rendered pages for the MCP authorization flow (F12): the consent screen
 * and the error page shown when we cannot safely redirect back to a client.
 * Every dynamic value is HTML-escaped. Each page gets its own CSP with a fresh
 * style nonce, no scripts at all, and frame-ancestors 'none' against clickjacking.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLES = `
  body { margin: 0; font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #70d1fe; color: #10264a; }
  header { background: #fed90f; border-bottom: 4px solid #10264a; padding: 1rem 2rem; font-weight: 800; font-size: 1.4rem; }
  header span { color: #c8341a; }
  main { max-width: 34rem; margin: 2rem auto; background: #fff; border: 3px solid #10264a; border-radius: 16px; padding: 1.5rem 2rem; }
  h1 { font-size: 1.25rem; margin-top: 0; }
  .muted { color: #4a5568; font-size: 0.9rem; }
  ul { padding-left: 1.2rem; }
  li { margin: 0.4rem 0; }
  li.denied { color: #4a5568; text-decoration: line-through; }
  code { background: #e3f5ff; padding: 0.1rem 0.3rem; border-radius: 4px; }
  .warning { background: #fff4b8; border-left: 4px solid #c8341a; padding: 0.5rem 0.75rem; border-radius: 4px; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
  button { font: inherit; font-weight: 700; border-radius: 8px; padding: 0.6rem 1.4rem; cursor: pointer; border: 2px solid #10264a; }
  button.allow { background: #c8341a; color: #fff; border-color: #c8341a; }
  button.deny { background: #fff; color: #10264a; }
  button:focus-visible { outline: 3px solid #10264a; outline-offset: 2px; }
`;

function send(res: Response, status: number, title: string, body: string, formActionOrigins: string[] = []) {
  const nonce = randomBytes(16).toString("base64");
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    // form-action must also allow the client's redirect origin: browsers apply it to
    // the redirect that follows the form submission.
    `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self' ${formActionOrigins.join(" ")}; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · TriviaNerd</title><style nonce="${nonce}">${STYLES}</style></head>
<body><header>Trivia<span>Nerd</span></header><main>${body}</main></body>
</html>`);
}

export function renderError(res: Response, status: number, message: string) {
  send(
    res,
    status,
    "Authorization error",
    `<h1>This connection request can't continue</h1><p>${escapeHtml(message)}</p>
     <p class="muted">You can close this tab and try connecting again from your app.</p>`,
  );
}

export interface ConsentView {
  clientName: string;
  clientIdHost: string;
  redirectUri: string;
  userLabel: string;
  grantedScopes: string[];
  deniedScopes: string[];
  requestToken: string;
}

export function renderConsent(res: Response, view: ConsentView) {
  const redirect = new URL(view.redirectUri);
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
  const scopeItem = (scope: string, granted: boolean) =>
    `<li${granted ? "" : ' class="denied"'}><strong>${escapeHtml(SCOPE_DESCRIPTIONS[scope] ?? scope)}</strong>
       <span class="muted">(<code>${escapeHtml(scope)}</code>${granted ? "" : ", not available for your role"})</span></li>`;

  send(
    res,
    200,
    "Connect an app",
    `<h1>${escapeHtml(view.clientName)} wants to connect to your TriviaNerd account</h1>
     <p class="muted">Signed in as ${escapeHtml(view.userLabel)} · app identifier from <code>${escapeHtml(view.clientIdHost)}</code></p>
     <p>If you allow it, this app will be able to:</p>
     <ul>${view.grantedScopes.map((s) => scopeItem(s, true)).join("")}${view.deniedScopes.map((s) => scopeItem(s, false)).join("")}</ul>
     <p>After you choose, you'll be sent back to <strong>${escapeHtml(redirect.host)}</strong>.</p>
     ${isLoopback ? `<p class="warning">This app runs on your own computer (<code>${escapeHtml(redirect.host)}</code>). Only allow it if you started it yourself.</p>` : ""}
     <form method="post" action="/auth/oauth/authorize">
       <input type="hidden" name="request" value="${escapeHtml(view.requestToken)}">
       <div class="actions">
         <button class="allow" type="submit" name="decision" value="allow">Allow</button>
         <button class="deny" type="submit" name="decision" value="deny">Deny</button>
       </div>
     </form>`,
    [redirect.origin],
  );
}

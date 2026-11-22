import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The TriviaNerd MCP App (F13) as an MCP resource: the single-file HTML built
 * by the mcp-app workspace (mcp-app/dist/quiz.html), served as
 * `ui://trivianerd/quiz.html` with MIME type `text/html;profile=mcp-app`.
 */

export const QUIZ_URI = "ui://trivianerd/quiz.html";

/**
 * MCP Apps CSP for the quiz (spec 2026-01-26: hosts default to connect-src 'none').
 * The app needs no network access of its own (every call goes through the host);
 * it only loads question images from The Simpsons API's CDN.
 */
export const QUIZ_UI_META = {
  ui: {
    csp: { resourceDomains: ["https://cdn.thesimpsonsapi.com"] },
    prefersBorder: true,
  },
};

// Same relative position from src/mcp (tsx) and dist/mcp (compiled): backend/<x>/mcp → repo root.
const htmlPath = () => process.env.MCP_APP_HTML ?? fileURLToPath(new URL("../../../mcp-app/dist/quiz.html", import.meta.url));

const NOT_BUILT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TriviaNerd</title></head>
<body style="font-family:sans-serif;padding:1rem"><p role="alert">The TriviaNerd quiz app has not been built on this server.
Run <code>npm run build --workspace=mcp-app</code>.</p></body></html>`;

let cached: string | undefined;

/** The built app HTML (cached after the first successful read), or a clear placeholder. */
export function quizHtml(): string {
  if (cached) return cached;
  try {
    cached = fs.readFileSync(htmlPath(), "utf8");
    return cached;
  } catch {
    console.error(`MCP App HTML not found at ${htmlPath()}; serving a placeholder`);
    return NOT_BUILT; // not cached: a later build is picked up without a restart
  }
}

import { getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Router } from "express";
import { authConfig } from "../auth/config.js";
import { callerFromAuthInfo, mcpTokenVerifier } from "../mcp/caller.js";
import { buildMcpServer } from "../mcp/tools.js";
import { byIp, rateLimit } from "../middleware/rateLimit.js";

/**
 * The MCP endpoint (F12): Streamable HTTP at /mcp, stateless (a fresh MCP server
 * per request, bound to the caller from the validated token).
 *
 *   no / invalid token  → 401 + WWW-Authenticate: Bearer resource_metadata="…"
 *   token lacks a tool's scope → 403 + WWW-Authenticate: Bearer error="insufficient_scope", scope="…"
 *
 * Only tokens whose audience is this MCP URL are accepted (mcp/caller.ts).
 */
export const mcpRouter = Router();

const resourceUrl = () => new URL(authConfig.mcpResource);

const handler = createMcpHandler((ctx) => buildMcpServer(callerFromAuthInfo(ctx.authInfo)), {
  onerror: (err) => console.error("mcp handler error", err),
});
const node = toNodeHandler(handler);

/** Stops in-flight MCP exchanges (graceful shutdown). */
export const closeMcp = () => handler.close();

// S1: per authenticated MCP user (each tools/call is one request).
const mcpLimiter = rateLimit({
  name: "MCP",
  windowMs: 60_000,
  max: 120,
  key: (req) => (req.auth?.extra?.userId ? `mcp-user:${String(req.auth.extra.userId)}` : byIp(req)),
});

// Built lazily so the URLs follow the environment's AUTH_ISSUER at request time.
let bearer: ReturnType<typeof requireBearerAuth> | undefined;
let bearerFor: string | undefined;
function bearerAuth() {
  if (!bearer || bearerFor !== authConfig.mcpResource) {
    bearer = requireBearerAuth({
      verifier: mcpTokenVerifier,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl()),
      expectedResource: resourceUrl(),
    });
    bearerFor = authConfig.mcpResource;
  }
  return bearer;
}

mcpRouter.all(
  "/mcp",
  (req, res, next) => bearerAuth()(req, res, next),
  mcpLimiter,
  (req, res) => void node(req, res, req.body),
);

import { recordAudit } from "../lib/audit.js";
import type { McpCaller } from "./caller.js";

/**
 * Every MCP tool call is audited (F12), including calls refused for missing
 * scope: who (from the validated token), which client, which tool, the outcome
 * and a bounded summary of the arguments (confirmation codes redacted).
 */
export type ToolOutcome = "ok" | "error" | "refused_insufficient_scope" | "refused_role" | "confirmation_required";

const MAX_STRING = 200;
const REDACTED_KEYS = new Set(["confirmationCode"]);

function summarize(args: unknown): unknown {
  if (args === null || typeof args !== "object") return args ?? null;
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([k, v]) => [
      k,
      REDACTED_KEYS.has(k) ? "[redacted]" : typeof v === "string" && v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v,
    ]),
  );
}

export async function auditToolCall(caller: McpCaller, tool: string, outcome: ToolOutcome, args?: unknown) {
  await recordAudit({
    actorUserId: caller.userId,
    action: "mcp.tool_call",
    entityType: "mcp_tool",
    before: null,
    after: { tool, clientId: caller.clientId, outcome, args: summarize(args) },
  });
}

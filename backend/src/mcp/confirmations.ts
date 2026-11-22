import { createHash, randomInt } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { mcpPendingActions } from "../db/schema.js";

/**
 * Confirmation codes for MCP write tools (F12: "write tool that requires
 * confirmation"). Enforced by the server, not left to the AI client's judgement:
 *   - the first call stores the exact payload and returns a short code; nothing
 *     is written;
 *   - the write happens only on a second call by the SAME user, carrying the
 *     code AND the identical payload (no bait-and-switch), within 5 minutes;
 *   - a code works once.
 */

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
// No 0/O/1/I/L: easy to read aloud and copy.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Stable hash of a payload: keys sorted so property order does not matter. */
export function payloadHash(payload: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)));
  return sha256(JSON.stringify(sorted));
}

export async function createConfirmation(userId: number, action: string, payload: Record<string, unknown>) {
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  await db.insert(mcpPendingActions).values({
    codeHash: sha256(code),
    userId,
    action,
    payloadHash: payloadHash(payload),
    payload,
    expiresAt,
  });
  return { code, expiresAt };
}

export type ConfirmResult = { ok: true } | { ok: false; reason: string };

/** Consumes a code if it belongs to this user and action, is unexpired, unused, and matches the payload. */
export async function consumeConfirmation(
  userId: number,
  action: string,
  code: string,
  payload: Record<string, unknown>,
): Promise<ConfirmResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(mcpPendingActions)
      .where(eq(mcpPendingActions.codeHash, sha256(code.trim().toUpperCase())))
      .for("update");
    if (!row || row.userId !== userId || row.action !== action) return { ok: false, reason: "unknown confirmation code" } as const;
    if (row.usedAt) return { ok: false, reason: "this confirmation code was already used" } as const;
    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "this confirmation code has expired" } as const;
    if (row.payloadHash !== payloadHash(payload)) {
      return { ok: false, reason: "the request differs from what was confirmed; ask for a new confirmation" } as const;
    }
    await tx
      .update(mcpPendingActions)
      .set({ usedAt: new Date() })
      .where(and(eq(mcpPendingActions.id, row.id), isNull(mcpPendingActions.usedAt)));
    return { ok: true } as const;
  });
}

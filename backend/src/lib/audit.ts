import { db } from "../db/client.js";
import { auditLog } from "../db/schema.js";

/**
 * Appends one audit event: who (actorUserId, derived from the validated token),
 * what (action/entityType/entityId), when (default timestamp), and the
 * before/after state (F6). Never update or delete rows in this table.
 */
export async function recordAudit(params: {
  actorUserId: number | null;
  action: string;
  entityType: string;
  entityId?: number | undefined;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: params.actorUserId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    before: params.before,
    after: params.after,
  });
}

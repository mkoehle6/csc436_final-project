import "../env.js"; // must stay first
import { eq } from "drizzle-orm";
import { isRole } from "../auth/scopes.js";
import { db, sqlite } from "../db/client.js";
import { users } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";

/**
 * Changes a user's role (F9). Run by an administrator with shell access to the
 * server, so there is deliberately no HTTP endpoint for it. Audited with a null
 * actor, which the audit log reads as "system / CLI".
 *
 *   npm run user:set-role -- someone@example.com operator
 *
 * The user must have signed in once. The new role applies from their next
 * access token (at most 15 minutes, or immediately after signing in again).
 */
const [email, role] = process.argv.slice(2);
if (!email || !isRole(role)) {
  console.error("Usage: npm run user:set-role -- <email> <viewer|operator>");
  process.exit(1);
}

const user = await db.query.users.findFirst({ where: eq(users.email, email) });
if (!user) {
  console.error(`No user with email ${email}. They must sign in once first.`);
  process.exit(1);
}

if (user.role === role) {
  console.log(`User ${user.id} is already ${role}.`);
} else {
  await db.update(users).set({ role }).where(eq(users.id, user.id));
  await recordAudit({
    actorUserId: null,
    action: "user.role_change",
    entityType: "user",
    entityId: user.id,
    before: { role: user.role },
    after: { role },
  });
  console.log(`User ${user.id}: ${user.role} -> ${role}.`);
}
sqlite.close();

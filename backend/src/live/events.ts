import { EventEmitter } from "node:events";
import { asc, gt, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { liveEvents } from "../db/schema.js";

/**
 * Durable, ordered live events (F11).
 *
 * Writers call publishInTx() inside the same transaction as the change being
 * announced; after commit they call notifyNewEvents(). Every SSE connection
 * keeps a cursor (the last event id it sent) and, when notified, reads events
 * with id > cursor from the database. Because the database is the source of
 * truth, a client that reconnects with Last-Event-ID (even to a restarted
 * server) gets exactly the events it missed: none lost, none repeated.
 */

/** Events older than this are pruned; a client further behind gets a fresh snapshot. */
export const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Upper bound on events replayed in one read. */
export const MAX_BATCH = 500;
/**
 * Arbitrary constant for pg_advisory_xact_lock. Serialising event inserts makes
 * ids commit in increasing order, so a reader can never move its cursor past an
 * id that is still uncommitted (which would silently skip that event).
 */
const EVENT_ORDER_LOCK = 4_711_011;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface LiveEvent {
  id: number;
  type: string;
  payload: unknown;
}

export async function publishInTx(tx: Tx, type: string, payload: unknown): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${EVENT_ORDER_LOCK})`);
  const [row] = await tx.insert(liveEvents).values({ type, payload }).returning({ id: liveEvents.id });
  return row!.id;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per open SSE connection

/** Wakes all open streams so they read new events. Call after the transaction commits. */
export function notifyNewEvents(): void {
  emitter.emit("new-events");
}

export function onNewEvents(listener: () => void): () => void {
  emitter.on("new-events", listener);
  return () => emitter.off("new-events", listener);
}

export async function eventsAfter(db: Db, cursor: number): Promise<LiveEvent[]> {
  return db
    .select({ id: liveEvents.id, type: liveEvents.type, payload: liveEvents.payload })
    .from(liveEvents)
    .where(gt(liveEvents.id, cursor))
    .orderBy(asc(liveEvents.id))
    .limit(MAX_BATCH);
}

/** The newest event id (0 if none): where a fresh client's cursor starts. */
export async function latestEventId(db: Db): Promise<number> {
  const [row] = await db.select({ max: sql<number | null>`max(${liveEvents.id})` }).from(liveEvents);
  return Number(row?.max ?? 0);
}

/** The oldest event id still available for replay (null if none). */
export async function oldestEventId(db: Db): Promise<number | null> {
  const [row] = await db.select({ min: sql<number | null>`min(${liveEvents.id})` }).from(liveEvents);
  return row?.min == null ? null : Number(row.min);
}

export async function pruneOldEvents(db: Db): Promise<void> {
  await db.delete(liveEvents).where(lt(liveEvents.createdAt, new Date(Date.now() - REPLAY_WINDOW_MS)));
}

import { desc, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gameSessions } from "../db/schema.js";
import { nicknameFor } from "./nickname.js";

export const LEADERBOARD_SIZE = 10;

export interface LeaderboardEntry {
  rank: number;
  player: string; // synthetic nickname, never a real name or email
  points: number;
  sessions: number;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Top players by total points across all their game sessions. */
export async function leaderboard(db: Db | Tx): Promise<LeaderboardEntry[]> {
  const points = sql<number>`sum(${gameSessions.score})::int`;
  const rows = await db
    .select({ userId: gameSessions.userId, points, sessions: sql<number>`count(*)::int` })
    .from(gameSessions)
    .groupBy(gameSessions.userId)
    .having(sql`sum(${gameSessions.score}) > 0`)
    .orderBy(desc(points), gameSessions.userId)
    .limit(LEADERBOARD_SIZE);

  return rows.map((r, i) => ({ rank: i + 1, player: nicknameFor(r.userId), points: r.points, sessions: r.sessions }));
}

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { answers, auditLog, gameSessions, questions } from "../db/schema.js";
import { notifyNewEvents, publishInTx, pruneOldEvents } from "../live/events.js";
import { leaderboard } from "../live/leaderboard.js";
import { nicknameFor } from "../live/nickname.js";
import { recordAudit } from "./audit.js";
import { answersCounter } from "./metrics.js";
import { computeScore, type ScoreResult } from "./scoring.js";

/**
 * Gameplay shared by every channel that can play: the web API
 * (routes/sessions.ts) and the MCP App (mcp/tools.ts). One code path means the
 * same scoring, the same transaction, the same audit entry and the same live
 * leaderboard event, whichever client the player uses.
 */

/** Prune the live-event replay buffer every this many events. */
const PRUNE_EVERY = 100;

export type Channel = "web" | "mcp";

export async function startGameSession(userId: number, channel: Channel) {
  const [created] = await db.insert(gameSessions).values({ userId }).returning();
  await recordAudit({
    actorUserId: userId,
    action: "session.start",
    entityType: "game_session",
    entityId: created?.id,
    after: { ...created, via: channel },
  });
  return created!;
}

export type RecordAnswerResult =
  | {
      ok: true;
      answer: typeof answers.$inferSelect;
      isCorrect: boolean;
      correctAnswer: string;
      score: ScoreResult;
      eventId: number;
    }
  | { ok: false; reason: "session_not_found" | "question_not_found" | "already_answered" };

/** Postgres unique_violation, as raised by node-postgres or PGlite (possibly wrapped by Drizzle). */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);
  return code(err) === "23505" || code((err as { cause?: unknown } | null)?.cause) === "23505";
}

/**
 * Records one answer in the player's own session. The answer, the session's
 * running score, the audit entry and the live-leaderboard event are written in
 * one transaction, so none can exist without the others.
 */
export async function recordAnswer(
  userId: number,
  sessionId: number,
  questionId: number,
  selectedAnswer: string,
  channel: Channel,
): Promise<RecordAnswerResult> {
  const session = await db.query.gameSessions.findFirst({ where: eq(gameSessions.id, sessionId) });
  // Someone else's session is reported as missing, so ids cannot be probed.
  if (!session || session.userId !== userId) return { ok: false, reason: "session_not_found" };
  const question = await db.query.questions.findFirst({ where: eq(questions.id, questionId) });
  if (!question) return { ok: false, reason: "question_not_found" };

  const isCorrect = selectedAnswer === question.correctAnswer;
  try {
    const result = await db.transaction(async (tx) => {
      const [created] = await tx.insert(answers).values({ sessionId, questionId, selectedAnswer, isCorrect }).returning();
      const all = await tx.query.answers.findMany({ where: eq(answers.sessionId, sessionId) });
      const score = computeScore(all.map((a) => ({ isCorrect: a.isCorrect })));
      await tx.update(gameSessions).set({ score: score.points }).where(eq(gameSessions.id, sessionId));
      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "answer.submit",
        entityType: "answer",
        entityId: created?.id,
        before: { score: session.score },
        after: { sessionId, questionId, isCorrect, score: score.points, via: channel },
      });
      // F11: the live event exists if and only if the answer does. Public payload: nickname only.
      const eventId = await publishInTx(tx, "score", {
        player: nicknameFor(userId),
        isCorrect,
        sessionPoints: score.points,
        leaderboard: await leaderboard(tx),
      });
      return { answer: created!, score, eventId };
    });
    notifyNewEvents(); // after commit: wake open streams
    if (result.eventId % PRUNE_EVERY === 0) void pruneOldEvents(db).catch(() => undefined);
    answersCounter.add(1, { channel, correct: String(isCorrect) });
    return { ok: true, ...result, isCorrect, correctAnswer: question.correctAnswer };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "already_answered" };
    throw err;
  }
}

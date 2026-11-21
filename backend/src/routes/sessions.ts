import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { answers, auditLog, gameSessions, questions } from "../db/schema.js";
import { ApiErrors } from "../lib/errors.js";
import { computeScore } from "../lib/scoring.js";
import { SCOPES } from "../auth/scopes.js";
import { actorUserId, requireAuth, requireScope } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";

export const sessionsRouter = Router();

/** POST /api/sessions — start a new game session for the authenticated user. */
sessionsRouter.post("/sessions", requireAuth, requireScope(SCOPES.play), async (req, res, next) => {
  try {
    const userId = actorUserId(req);
    const [created] = await db.insert(gameSessions).values({ userId }).returning();
    await recordAudit({
      actorUserId: userId,
      action: "session.start",
      entityType: "game_session",
      entityId: created?.id,
      after: created,
    });
    res.status(201).location(`/api/sessions/${created?.id}`).json(created);
  } catch (err) {
    next(err);
  }
});

const submitAnswerSchema = z.object({
  questionId: z.number().int().positive(),
  selectedAnswer: z.string().min(1),
});

/** Postgres unique_violation, as raised by node-postgres or PGlite (possibly wrapped by Drizzle). */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);
  return code(err) === "23505" || code((err as { cause?: unknown } | null)?.cause) === "23505";
}

/**
 * POST /api/sessions/:id/answers — record one answer in the caller's session.
 * 404 if the session (or question) is missing or not theirs; 409 if this
 * question was already answered in the session. The answer, the session's
 * running score and the audit entry are written in one transaction.
 */
sessionsRouter.post("/sessions/:id/answers", requireAuth, requireScope(SCOPES.play), async (req, res, next) => {
  const sessionId = Number(req.params.id);
  const parsed = submitAnswerSchema.safeParse(req.body);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    next(ApiErrors.badRequest("id must be a positive integer"));
    return;
  }
  if (!parsed.success) {
    next(ApiErrors.badRequest("Invalid answer payload", parsed.error.flatten()));
    return;
  }

  try {
    const userId = actorUserId(req);
    const session = await db.query.gameSessions.findFirst({
      where: eq(gameSessions.id, sessionId),
    });
    // Someone else's session is reported as missing, so ids cannot be probed.
    if (!session || session.userId !== userId) {
      throw ApiErrors.notFound("Session not found");
    }
    const question = await db.query.questions.findFirst({
      where: eq(questions.id, parsed.data.questionId),
    });
    if (!question) {
      throw ApiErrors.notFound("Question not found");
    }

    const isCorrect = parsed.data.selectedAnswer === question.correctAnswer;
    const result = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(answers)
        .values({ sessionId, questionId: question.id, selectedAnswer: parsed.data.selectedAnswer, isCorrect })
        .returning();
      const all = await tx.query.answers.findMany({ where: eq(answers.sessionId, sessionId) });
      const score = computeScore(all.map((a) => ({ isCorrect: a.isCorrect })));
      await tx.update(gameSessions).set({ score: score.points }).where(eq(gameSessions.id, sessionId));
      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "answer.submit",
        entityType: "answer",
        entityId: created?.id,
        before: { score: session.score },
        after: { sessionId, questionId: question.id, isCorrect, score: score.points },
      });
      return { answer: created, score };
    });

    res
      .status(201)
      .location(`/api/sessions/${sessionId}`)
      .json({ ...result, isCorrect, correctAnswer: question.correctAnswer });
  } catch (err) {
    if (isUniqueViolation(err)) {
      next(ApiErrors.conflict("This question was already answered in this session"));
      return;
    }
    next(err);
  }
});

/** GET /api/sessions/:id — fetch a session's current score using the shared scoring calculation. */
sessionsRouter.get("/sessions/:id", requireAuth, requireScope(SCOPES.read), async (req, res, next) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    next(ApiErrors.badRequest("id must be a positive integer"));
    return;
  }
  try {
    const session = await db.query.gameSessions.findFirst({
      where: eq(gameSessions.id, sessionId),
    });
    if (!session || session.userId !== actorUserId(req)) {
      next(ApiErrors.notFound("Session not found"));
      return;
    }
    const sessionAnswers = await db.query.answers.findMany({
      where: eq(answers.sessionId, sessionId),
    });
    const score = computeScore(sessionAnswers.map((a) => ({ isCorrect: a.isCorrect })));
    res.status(200).json({ session, score });
  } catch (err) {
    next(err);
  }
});

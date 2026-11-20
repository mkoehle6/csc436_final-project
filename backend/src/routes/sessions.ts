import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { answers, gameSessions, questions } from "../db/schema.js";
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

/** POST /api/sessions/:id/answers — record one answer; 404 if session or question is missing. */
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
    const session = await db.query.gameSessions.findFirst({
      where: eq(gameSessions.id, sessionId),
    });
    if (!session || session.userId !== actorUserId(req)) {
      next(ApiErrors.notFound("Session not found"));
      return;
    }
    const question = await db.query.questions.findFirst({
      where: eq(questions.id, parsed.data.questionId),
    });
    if (!question) {
      next(ApiErrors.notFound("Question not found"));
      return;
    }

    const isCorrect = parsed.data.selectedAnswer === question.correctAnswer;
    const [created] = await db
      .insert(answers)
      .values({
        sessionId,
        questionId: parsed.data.questionId,
        selectedAnswer: parsed.data.selectedAnswer,
        isCorrect,
      })
      .returning();

    res.status(201).json(created);
  } catch (err) {
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

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { answers, gameSessions } from "../db/schema.js";
import { ApiErrors } from "../lib/errors.js";
import { recordAnswer, startGameSession } from "../lib/gameplay.js";
import { computeScore } from "../lib/scoring.js";
import { SCOPES } from "../auth/scopes.js";
import { actorUserId, requireAuth, requireScope } from "../middleware/auth.js";
import { limits } from "../middleware/rateLimit.js";

export const sessionsRouter = Router();

/** Starting sessions and submitting answers: counted per signed-in player (S1). */
const playLimiter = limits.writes();

/** POST /api/sessions — start a new game session for the authenticated user. */
sessionsRouter.post("/sessions", requireAuth, requireScope(SCOPES.play), playLimiter, async (req, res, next) => {
  try {
    const created = await startGameSession(actorUserId(req), "web");
    res.status(201).location(`/api/sessions/${created.id}`).json(created);
  } catch (err) {
    next(err);
  }
});

const submitAnswerSchema = z.object({
  questionId: z.number().int().positive(),
  selectedAnswer: z.string().min(1),
});

/**
 * POST /api/sessions/:id/answers — record one answer in the caller's session
 * (lib/gameplay.ts, shared with the MCP App). 404 if the session (or question)
 * is missing or not theirs; 409 if this question was already answered.
 */
sessionsRouter.post("/sessions/:id/answers", requireAuth, requireScope(SCOPES.play), playLimiter, async (req, res, next) => {
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
    const result = await recordAnswer(actorUserId(req), sessionId, parsed.data.questionId, parsed.data.selectedAnswer, "web");
    if (!result.ok) {
      if (result.reason === "already_answered") throw ApiErrors.conflict("This question was already answered in this session");
      throw ApiErrors.notFound(result.reason === "session_not_found" ? "Session not found" : "Question not found");
    }
    const { answer, score, eventId, isCorrect, correctAnswer } = result;
    res.status(201).location(`/api/sessions/${sessionId}`).json({ answer, score, eventId, isCorrect, correctAnswer });
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

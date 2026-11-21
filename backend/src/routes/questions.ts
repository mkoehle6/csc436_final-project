import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { answers, questions } from "../db/schema.js";
import { ApiErrors } from "../lib/errors.js";
import { getRound, publicQuestionColumns } from "../lib/questionBank.js";
import { SCOPES } from "../auth/scopes.js";
import { actorUserId, requireAuth, requireRole, requireScope } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";

export const questionsRouter = Router();

/** Writes need a valid token (401), the operator role (403) and the questions:write scope (403). */
const canWriteQuestions = [requireAuth, requireRole("operator"), requireScope(SCOPES.writeQuestions)];

const categorySchema = z.enum(questions.category.enumValues);

const idParamSchema = z.coerce.number().int().positive();

function parseId(raw: unknown): number {
  const id = idParamSchema.safeParse(raw);
  if (!id.success) throw ApiErrors.badRequest("id must be a positive integer");
  return id.data;
}

const listQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(20).default(9),
  category: categorySchema.default("character"),
});

/**
 * GET /api/questions — public. A random round from the question bank, without
 * correct answers. Random per request, so never shared-cached (D6).
 */
questionsRouter.get("/questions", async (req, res, next) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(ApiErrors.badRequest("Invalid query parameters", parsed.error.flatten()));
    return;
  }
  try {
    const round = await getRound(parsed.data.category, parsed.data.count);
    if (round.questions.length === 0 && round.degraded) {
      throw ApiErrors.upstreamUnavailable("No questions available while The Simpsons API is unreachable");
    }
    if (round.degraded) req.log.warn("question bank top-up failed; served from the existing bank");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(round);
  } catch (err) {
    next(err);
  }
});

/** GET /api/questions/:id — public; one question, without its answer. */
questionsRouter.get("/questions/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const [question] = await db.select(publicQuestionColumns).from(questions).where(eq(questions.id, id));
    if (!question) throw ApiErrors.notFound("Question not found");
    res.status(200).json(question);
  } catch (err) {
    next(err);
  }
});

const checkAnswerSchema = z.object({
  selectedAnswer: z.string().min(1).max(500),
});

/**
 * POST /api/questions/:id/check — public. Lets anonymous visitors play: the
 * server says whether the choice was right and reveals the answer afterwards.
 * Nothing is stored; signed-in players use /api/sessions/:id/answers instead.
 */
questionsRouter.post("/questions/:id/check", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const body = checkAnswerSchema.safeParse(req.body);
    if (!body.success) throw ApiErrors.badRequest("Invalid answer payload", body.error.flatten());

    const question = await db.query.questions.findFirst({ where: eq(questions.id, id) });
    if (!question) throw ApiErrors.notFound("Question not found");

    res.status(200).json({
      questionId: question.id,
      selectedAnswer: body.data.selectedAnswer,
      isCorrect: body.data.selectedAnswer === question.correctAnswer,
      correctAnswer: question.correctAnswer,
    });
  } catch (err) {
    next(err);
  }
});

const createQuestionSchema = z.object({
  prompt: z.string().min(1).max(500),
  category: categorySchema,
  correctAnswer: z.string().min(1),
  choices: z.array(z.string().min(1)).length(4),
  imagePath: z.string().url().optional(),
  sourceEntityId: z.number().int().positive(),
});

/** POST /api/questions — operator-only write; 409 if the question already exists; audited (F6, F9). */
questionsRouter.post("/questions", ...canWriteQuestions, async (req, res, next) => {
  try {
    const parsed = createQuestionSchema.safeParse(req.body);
    if (!parsed.success) throw ApiErrors.badRequest("Invalid question payload", parsed.error.flatten());
    if (!parsed.data.choices.includes(parsed.data.correctAnswer)) {
      throw ApiErrors.badRequest("correctAnswer must be one of choices");
    }

    const [created] = await db
      .insert(questions)
      .values(parsed.data)
      .onConflictDoNothing({ target: [questions.category, questions.prompt] })
      .returning();
    if (!created) throw ApiErrors.conflict("A question with this prompt already exists in this category");

    await recordAudit({
      actorUserId: actorUserId(req),
      action: "question.create",
      entityType: "question",
      entityId: created.id,
      before: null,
      after: created,
    });
    res.status(201).location(`/api/questions/${created.id}`).json(created);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/questions/:id — operator-only; 409 if players have answered it; audited. */
questionsRouter.delete("/questions/:id", ...canWriteQuestions, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const existing = await db.query.questions.findFirst({ where: eq(questions.id, id) });
    if (!existing) throw ApiErrors.notFound("Question not found");

    const answered = await db.query.answers.findFirst({ where: eq(answers.questionId, id) });
    if (answered) throw ApiErrors.conflict("Question has recorded answers and cannot be deleted");

    await db.delete(questions).where(eq(questions.id, id));
    await recordAudit({
      actorUserId: actorUserId(req),
      action: "question.delete",
      entityType: "question",
      entityId: id,
      before: existing,
      after: null,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

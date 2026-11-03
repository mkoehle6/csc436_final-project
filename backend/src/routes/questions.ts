import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { questions } from "../db/schema.js";
import { ApiErrors } from "../lib/errors.js";
import { generateCharacterQuestions } from "../lib/questionGenerator.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";

export const questionsRouter = Router();

const listQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(20).default(5),
});

/** GET /api/questions — public read; generates + caches a fresh quiz round. */
questionsRouter.get("/questions", async (req, res, next) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(ApiErrors.badRequest("Invalid query parameters", parsed.error.flatten()));
    return;
  }
  try {
    const generated = await generateCharacterQuestions(parsed.data.count);
    const inserted = await db
      .insert(questions)
      .values(
        generated.map((q) => ({
          prompt: q.prompt,
          category: q.category,
          correctAnswer: q.correctAnswer,
          choices: q.choices,
          imagePath: q.imagePath,
          sourceEntityId: q.sourceEntityId,
        })),
      )
      .returning();
    res.status(200).json({ questions: inserted });
  } catch (err) {
    next(err);
  }
});

const createQuestionSchema = z.object({
  prompt: z.string().min(1).max(500),
  category: z.enum(["character", "episode", "location"]),
  correctAnswer: z.string().min(1),
  choices: z.array(z.string().min(1)).length(4),
  imagePath: z.string().url().optional(),
  sourceEntityId: z.number().int().positive(),
});

/** POST /api/questions — operator-only write; records an audit event (F6, F9). */
questionsRouter.post("/questions", requireAuth, requireRole("operator"), async (req, res, next) => {
  const parsed = createQuestionSchema.safeParse(req.body);
  if (!parsed.success) {
    next(ApiErrors.badRequest("Invalid question payload", parsed.error.flatten()));
    return;
  }
  if (!parsed.data.choices.includes(parsed.data.correctAnswer)) {
    next(ApiErrors.badRequest("correctAnswer must be one of choices"));
    return;
  }
  try {
    const [created] = await db.insert(questions).values(parsed.data).returning();
    await recordAudit({
      actorUserId: req.user?.sub ? Number(req.user.sub) : null,
      action: "question.create",
      entityType: "question",
      entityId: created?.id,
      before: null,
      after: created,
    });
    res.status(201).location(`/api/questions/${created?.id}`).json(created);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/questions/:id — operator-only write; records an audit event. */
questionsRouter.delete(
  "/questions/:id",
  requireAuth,
  requireRole("operator"),
  async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      next(ApiErrors.badRequest("id must be a positive integer"));
      return;
    }
    try {
      const existing = await db.query.questions.findFirst({ where: eq(questions.id, id) });
      if (!existing) {
        next(ApiErrors.notFound());
        return;
      }
      await db.delete(questions).where(eq(questions.id, id));
      await recordAudit({
        actorUserId: req.user?.sub ? Number(req.user.sub) : null,
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
  },
);

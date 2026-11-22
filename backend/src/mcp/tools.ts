import { McpServer, requireScopes, type CallToolResult, type ScopeChallengeHandler } from "@modelcontextprotocol/server";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { SCOPES } from "../auth/scopes.js";
import { db } from "../db/client.js";
import { answers, gameSessions, questions, users } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { getRound } from "../lib/questionBank.js";
import { leaderboard } from "../live/leaderboard.js";
import { nicknameFor } from "../live/nickname.js";
import { auditToolCall, type ToolOutcome } from "./audit.js";
import type { McpCaller } from "./caller.js";
import { CONFIRMATION_TTL_MS, consumeConfirmation, createConfirmation } from "./confirmations.js";

/**
 * The TriviaNerd MCP server (F12), built per request for one authenticated caller.
 *
 * Read tools (scope trivia:read): get_leaderboard, get_random_questions, get_my_stats.
 * Write tool (scope questions:write + operator role): add_question, which requires
 * a server-enforced confirmation step (mcp/confirmations.ts).
 *
 * Tools call application functions directly; the caller's token is never passed on.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function result(text: string, data: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: data, ...(isError ? { isError: true } : {}) };
}
const failure = (message: string) => result(message, { error: message }, true);

export function buildMcpServer(caller: McpCaller): McpServer {
  const server = new McpServer({ name: "trivianerd", title: "TriviaNerd", version: "1.0.0" });

  /** Scope check that also audits a refusal before the SDK answers 403 insufficient_scope. */
  const scope =
    (tool: string, required: string): ScopeChallengeHandler =>
    async (ctx) => {
      const challenge = await requireScopes(required)(ctx);
      if (challenge) await auditToolCall(caller, tool, "refused_insufficient_scope", ctx.request.params?.arguments);
      return challenge;
    };

  /** Runs a tool body and audits its outcome; unexpected errors become a generic tool error. */
  const audited =
    <A>(tool: string, run: (args: A) => Promise<{ outcome: ToolOutcome; result: CallToolResult }>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        const { outcome, result: res } = await run(args);
        await auditToolCall(caller, tool, outcome, args);
        return res;
      } catch (err) {
        await auditToolCall(caller, tool, "error", args).catch(() => undefined);
        console.error(`mcp tool ${tool} failed`, err);
        return failure("Something went wrong on the TriviaNerd server.");
      }
    };

  server.registerTool(
    "get_leaderboard",
    {
      title: "Leaderboard",
      description: "Top TriviaNerd players by total points. Players are shown under nicknames, never real names.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      scopeChallenge: scope("get_leaderboard", SCOPES.read),
    },
    audited("get_leaderboard", async () => {
      const board = await leaderboard(db);
      const text =
        board.length === 0
          ? "No scores yet."
          : board.map((e) => `${e.rank}. ${e.player} - ${e.points} pts (${e.sessions} games)`).join("\n");
      return { outcome: "ok", result: result(text, { leaderboard: board }) };
    }),
  );

  server.registerTool(
    "get_random_questions",
    {
      title: "Sample questions",
      description: "A few random Simpsons trivia questions with their answer choices. Correct answers are not included.",
      inputSchema: z.object({
        count: z.number().int().min(1).max(10).default(3).describe("How many questions (1-10)"),
        category: z.enum(["character", "episode", "location"]).default("character"),
      }),
      annotations: READ_ONLY,
      scopeChallenge: scope("get_random_questions", SCOPES.read),
    },
    audited("get_random_questions", async ({ count: n, category }: { count: number; category: "character" | "episode" | "location" }) => {
      const round = await getRound(category, n);
      const text = round.questions.length
        ? round.questions.map((q, i) => `${i + 1}. ${q.prompt}\n   ${q.choices.join(" | ")}`).join("\n")
        : "No questions available right now.";
      return { outcome: "ok", result: result(text, { questions: round.questions, degraded: round.degraded }) };
    }),
  );

  server.registerTool(
    "get_my_stats",
    {
      title: "My stats",
      description: "Your own TriviaNerd results: games played, total points, accuracy and recent games.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      scopeChallenge: scope("get_my_stats", SCOPES.read),
    },
    audited("get_my_stats", async () => {
      const mine = eq(gameSessions.userId, caller.userId);
      const [games] = await db
        .select({ games: count(), points: sql<number>`coalesce(sum(${gameSessions.score}), 0)::int` })
        .from(gameSessions)
        .where(mine);
      const [answered] = await db
        .select({ total: count(), correct: sql<number>`count(*) filter (where ${answers.isCorrect})::int` })
        .from(answers)
        .innerJoin(gameSessions, eq(answers.sessionId, gameSessions.id))
        .where(mine);
      const recent = await db
        .select({ startedAt: gameSessions.startedAt, points: gameSessions.score })
        .from(gameSessions)
        .where(mine)
        .orderBy(desc(gameSessions.startedAt))
        .limit(5);
      const total = answered?.total ?? 0;
      const correct = answered?.correct ?? 0;
      const stats = {
        player: nicknameFor(caller.userId),
        games: games?.games ?? 0,
        totalPoints: games?.points ?? 0,
        answers: total,
        correct,
        accuracyPercent: total === 0 ? 0 : Math.round((correct / total) * 1000) / 10,
        recentGames: recent.map((r) => ({ startedAt: r.startedAt.toISOString(), points: r.points })),
      };
      const text = `${stats.player}: ${stats.games} games, ${stats.totalPoints} points, ${stats.correct}/${stats.answers} correct (${stats.accuracyPercent}%).`;
      return { outcome: "ok", result: result(text, stats) };
    }),
  );

  const addQuestionInput = z.object({
    prompt: z.string().trim().min(5).max(300).describe("The question, e.g. \"What is Moe Szyslak's occupation?\""),
    correctAnswer: z.string().trim().min(1).max(100),
    wrongAnswers: z.array(z.string().trim().min(1).max(100)).length(3).describe("Exactly three wrong answers"),
    category: z.enum(["character", "episode", "location"]).default("character"),
    confirmationCode: z
      .string()
      .optional()
      .describe("Leave empty on the first call. Only set it after the user has seen the preview and confirmed."),
  });
  type AddQuestionArgs = z.infer<typeof addQuestionInput>;

  server.registerTool(
    "add_question",
    {
      title: "Add a question (requires confirmation)",
      description:
        "Adds a question to the TriviaNerd question bank. Operators only. Two steps: the first call (no confirmationCode) " +
        "creates nothing and returns a preview plus a confirmation code; show the preview to the user and ask them to " +
        "confirm. Only if they confirm, call again with exactly the same fields plus the confirmationCode.",
      inputSchema: addQuestionInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      scopeChallenge: scope("add_question", SCOPES.writeQuestions),
    },
    audited("add_question", async (args: AddQuestionArgs) => {
      // The role is re-checked against the database: it may have changed since consent.
      const user = await db.query.users.findFirst({ where: eq(users.id, caller.userId) });
      if (user?.role !== "operator") {
        return { outcome: "refused_role", result: failure("Only TriviaNerd operators can add questions.") };
      }

      const choices = [args.correctAnswer, ...args.wrongAnswers];
      if (new Set(choices.map((c) => c.toLowerCase())).size !== 4) {
        return { outcome: "error", result: failure("The correct answer and the three wrong answers must all be different.") };
      }
      const payload = { prompt: args.prompt, category: args.category, correctAnswer: args.correctAnswer, wrongAnswers: args.wrongAnswers };

      const existing = await db.query.questions.findFirst({
        where: and(eq(questions.category, args.category), eq(questions.prompt, args.prompt)),
      });
      if (existing) return { outcome: "error", result: failure(`A ${args.category} question with this prompt already exists (#${existing.id}).`) };

      if (!args.confirmationCode) {
        const { code, expiresAt } = await createConfirmation(caller.userId, "add_question", payload);
        const preview = `Question: ${args.prompt}\nCorrect answer: ${args.correctAnswer}\nWrong answers: ${args.wrongAnswers.join(", ")}\nCategory: ${args.category}`;
        return {
          outcome: "confirmation_required",
          result: result(
            `NOTHING HAS BEEN CREATED YET. Show this preview to the user and ask them to confirm:\n\n${preview}\n\n` +
              `If they confirm, call add_question again with exactly the same fields and confirmationCode "${code}" ` +
              `(valid ${CONFIRMATION_TTL_MS / 60_000} minutes, single use). If they do not confirm, do nothing.`,
            { status: "confirmation_required", preview: payload, confirmationCode: code, expiresAt: expiresAt.toISOString() },
          ),
        };
      }

      const confirmed = await consumeConfirmation(caller.userId, "add_question", args.confirmationCode, payload);
      if (!confirmed.ok) return { outcome: "error", result: failure(`Not created: ${confirmed.reason}.`) };

      const [created] = await db
        .insert(questions)
        .values({
          prompt: args.prompt,
          category: args.category,
          correctAnswer: args.correctAnswer,
          choices: [...choices].sort(() => Math.random() - 0.5),
          imagePath: null,
          sourceEntityId: 0,
        })
        .onConflictDoNothing({ target: [questions.category, questions.prompt] })
        .returning();
      if (!created) return { outcome: "error", result: failure("Not created: the question was added by someone else meanwhile.") };

      await recordAudit({
        actorUserId: caller.userId,
        action: "question.create",
        entityType: "question",
        entityId: created.id,
        before: null,
        after: { ...created, via: "mcp", clientId: caller.clientId },
      });
      return { outcome: "ok", result: result(`Created question #${created.id}.`, { status: "created", questionId: created.id }) };
    }),
  );

  return server;
}

import { count, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { questions } from "../db/schema.js";
import { generateCharacterQuestions } from "./questionGenerator.js";

/**
 * The question bank: questions are served from our database, and the bank is
 * topped up from The Simpsons API only while it is small. Once it holds
 * MIN_BANK_SIZE questions for a category, page views cause no writes and no
 * third-party calls at all.
 *
 * This is also the graceful-degradation path (F10): if the provider is down,
 * players still get questions from the bank; only an empty bank fails.
 */

export type Category = (typeof questions.category.enumValues)[number];

/** Below this many questions in a category, a request tops the bank up. */
export const MIN_BANK_SIZE = 60;
/** Questions generated per top-up: one Simpsons API page holds ~20 characters. */
const TOP_UP_BATCH = 20;
/** Categories the generator can produce today. */
const GENERATABLE: ReadonlySet<Category> = new Set<Category>(["character"]);

/** What players may see. The correct answer is never sent before they answer. */
export const publicQuestionColumns = {
  id: questions.id,
  prompt: questions.prompt,
  category: questions.category,
  choices: questions.choices,
  imagePath: questions.imagePath,
};

export type PublicQuestion = {
  id: number;
  prompt: string;
  category: Category;
  choices: string[];
  imagePath: string | null;
};

async function bankSize(category: Category): Promise<number> {
  const [row] = await db.select({ n: count() }).from(questions).where(eq(questions.category, category));
  return row?.n ?? 0;
}

async function topUp(category: Category): Promise<number> {
  const generated = await generateCharacterQuestions(TOP_UP_BATCH);
  const inserted = await db
    .insert(questions)
    .values(generated.map((q) => ({ ...q, category })))
    .onConflictDoNothing({ target: [questions.category, questions.prompt] })
    .returning({ id: questions.id });
  return inserted.length;
}

/**
 * Protects The Simpsons API from request-driven bursts (S1, F10):
 *  - single-flight: concurrent requests share one in-progress top-up instead
 *    of each starting their own;
 *  - cooldown: after an attempt (successful or not), requests wait at least
 *    TOP_UP_COOLDOWN_MS before triggering another, so a failing provider is
 *    not retried on every page view.
 * Warm-up at startup bypasses the cooldown (it is the server's own bounded loop).
 */
const DEFAULT_TOP_UP_COOLDOWN_MS = 10_000;
const topUpState = new Map<Category, { inFlight: Promise<number> | null; lastAttemptAt: number }>();

const cooldownMs = () => Number(process.env.QUESTION_TOPUP_COOLDOWN_MS ?? DEFAULT_TOP_UP_COOLDOWN_MS);

type TopUpOutcome = { status: "done"; added: number } | { status: "skipped" };

async function guardedTopUp(category: Category, { bypassCooldown = false } = {}): Promise<TopUpOutcome> {
  let state = topUpState.get(category);
  if (!state) {
    state = { inFlight: null, lastAttemptAt: 0 };
    topUpState.set(category, state);
  }
  if (state.inFlight) return { status: "done", added: await state.inFlight };
  if (!bypassCooldown && Date.now() - state.lastAttemptAt < cooldownMs()) return { status: "skipped" };

  state.lastAttemptAt = Date.now();
  const run = topUp(category);
  state.inFlight = run;
  try {
    return { status: "done", added: await run };
  } finally {
    state.inFlight = null;
  }
}

/** Top-ups attempted per category during warm-up (each fetches at most 3 pages). */
const WARM_UP_ATTEMPTS = 4;

/**
 * Fills each generatable category up to MIN_BANK_SIZE. Called once when the
 * server starts (not awaited), so the first visitor after a deploy, or after a
 * migration that cleared the bank, gets questions without waiting on the API.
 */
export async function warmUp(log: (message: string) => void): Promise<void> {
  for (const category of GENERATABLE) {
    let size = await bankSize(category);
    for (let attempt = 1; attempt <= WARM_UP_ATTEMPTS && size < MIN_BANK_SIZE; attempt++) {
      try {
        const outcome = await guardedTopUp(category, { bypassCooldown: true });
        const added = outcome.status === "done" ? outcome.added : 0;
        log(`question bank warm-up: added ${added} ${category} questions (had ${size})`);
      } catch (err) {
        log(`question bank warm-up failed for ${category}: ${(err as Error).message}`);
        break; // requests will retry on demand
      }
      size = await bankSize(category);
    }
    // Always report the final state, including when attempts ran out.
    log(
      size >= MIN_BANK_SIZE
        ? `question bank ready: ${category} has ${size} questions`
        : `question bank below minimum: ${category} has ${size} of ${MIN_BANK_SIZE}; requests will top up on demand`,
    );
  }
}

export interface RoundResult {
  questions: PublicQuestion[];
  /** True when the bank needed topping up but could not be (provider down, or in cooldown while empty). */
  degraded: boolean;
}

export async function getRound(category: Category, size: number): Promise<RoundResult> {
  let degraded = false;
  let skipped = false;
  if (GENERATABLE.has(category) && (await bankSize(category)) < Math.max(MIN_BANK_SIZE, size)) {
    try {
      skipped = (await guardedTopUp(category)).status === "skipped";
    } catch {
      degraded = true; // serve whatever the bank has
    }
  }

  const rows = await db
    .select(publicQuestionColumns)
    .from(questions)
    .where(eq(questions.category, category))
    .orderBy(sql`random()`)
    .limit(size);

  // A skipped top-up is only a problem if it leaves the player with nothing.
  if (skipped && rows.length === 0) degraded = true;
  return { questions: rows, degraded };
}

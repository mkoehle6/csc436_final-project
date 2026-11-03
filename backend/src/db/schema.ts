import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Users are provisioned from validated OIDC claims (sub/email) on first login.
 * `role` drives server-side authorization (F9): "viewer" can play/read, "operator" can
 * manage the question bank (write endpoints).
 */
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    oidcSubject: text("oidc_subject").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: text("role", { enum: ["viewer", "operator"] })
      .notNull()
      .default("viewer"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [uniqueIndex("users_oidc_subject_idx").on(table.oidcSubject)],
);

/**
 * Trivia questions, generated from The Simpsons API data and cached so gameplay
 * does not depend on the third-party API being up at question time.
 */
export const questions = sqliteTable(
  "questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    prompt: text("prompt").notNull(),
    category: text("category", {
      enum: ["character", "episode", "location"],
    }).notNull(),
    correctAnswer: text("correct_answer").notNull(),
    // JSON-encoded string[] of 4 choices including the correct answer.
    choices: text("choices", { mode: "json" }).$type<string[]>().notNull(),
    imagePath: text("image_path"),
    sourceEntityId: integer("source_entity_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [index("questions_category_idx").on(table.category)],
);

/**
 * One row per trivia playthrough, owned by the authenticated user.
 */
export const gameSessions = sqliteTable(
  "game_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    completedAt: text("completed_at"),
    score: integer("score").notNull().default(0),
  },
  (table) => [index("game_sessions_user_id_idx").on(table.userId)],
);

/**
 * One row per answered question within a session; used to compute score (core calculation, Q1).
 */
export const answers = sqliteTable(
  "answers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => gameSessions.id),
    questionId: integer("question_id")
      .notNull()
      .references(() => questions.id),
    selectedAnswer: text("selected_answer").notNull(),
    isCorrect: integer("is_correct", { mode: "boolean" }).notNull(),
    answeredAt: text("answered_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [index("answers_session_id_idx").on(table.sessionId)],
);

/**
 * Append-only audit trail (F6): who (actor from validated token), what (action +
 * entity), when, and before/after state as JSON snapshots.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorUserId: integer("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id"),
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [index("audit_log_entity_idx").on(table.entityType, table.entityId)],
);

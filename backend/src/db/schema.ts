import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * PostgreSQL schema (F4). Every table has a primary key; foreign keys are
 * declared below; each index carries a comment justifying the query it serves.
 *
 * Timestamps are `timestamptz` so values are unambiguous across servers and
 * time zones; Drizzle maps them to JS Date objects.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Enforced by the database, not just the app: an invalid role cannot be stored. */
export const userRole = pgEnum("user_role", ["viewer", "operator"]);
export const questionCategory = pgEnum("question_category", ["character", "episode", "location"]);

/**
 * Users are provisioned from validated OIDC claims (sub/email) on first login.
 * `role` drives server-side authorization (F9): "viewer" can play/read, "operator" can
 * manage the question bank (write endpoints).
 */
export const users = pgTable(
  "users",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    oidcSubject: text("oidc_subject").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: userRole("role").notNull().default("viewer"),
    createdAt: createdAt(),
  },
  // Every login looks the user up by Google subject; unique also prevents duplicate accounts.
  (table) => [uniqueIndex("users_oidc_subject_idx").on(table.oidcSubject)],
);

/**
 * Trivia questions, generated from The Simpsons API data and cached so gameplay
 * does not depend on the third-party API being up at question time.
 */
export const questions = pgTable(
  "questions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    prompt: text("prompt").notNull(),
    category: questionCategory("category").notNull(),
    correctAnswer: text("correct_answer").notNull(),
    // string[] of 4 choices including the correct answer.
    choices: jsonb("choices").$type<string[]>().notNull(),
    imagePath: text("image_path"),
    sourceEntityId: integer("source_entity_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // The category filter selects questions by category.
    index("questions_category_idx").on(table.category),
    // The bank is topped up from the Simpsons API; inserts use ON CONFLICT DO
    // NOTHING on this index, so the same question is never stored twice.
    uniqueIndex("questions_category_prompt_uq").on(table.category, table.prompt),
  ],
);

/**
 * One row per trivia playthrough, owned by the authenticated user.
 */
export const gameSessions = pgTable(
  "game_sessions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    score: integer("score").notNull().default(0),
  },
  // "My sessions" and the leaderboard group sessions by user.
  (table) => [index("game_sessions_user_id_idx").on(table.userId)],
);

/**
 * One row per answered question within a session; used to compute score (core calculation, Q1).
 */
export const answers = pgTable(
  "answers",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => gameSessions.id),
    questionId: integer("question_id")
      .notNull()
      .references(() => questions.id),
    selectedAnswer: text("selected_answer").notNull(),
    isCorrect: boolean("is_correct").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Scoring reads every answer of one session.
    index("answers_session_id_idx").on(table.sessionId),
    // A question can be answered once per session; a second attempt is a 409.
    uniqueIndex("answers_session_question_uq").on(table.sessionId, table.questionId),
  ],
);

/**
 * In-flight OAuth logins (F7). One row per /auth/login redirect, holding the
 * values Google must echo back (state, nonce) and the PKCE verifier we must
 * present at the token endpoint. Rows are single-use: the callback deletes the
 * row it consumes, and expired rows are swept on each new login.
 * Keyed by `state` because that is exactly what the callback looks up.
 */
export const oauthLoginStates = pgTable("oauth_login_states", {
  state: text("state").primaryKey(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /**
   * Where to continue after Google login when the login was started by an MCP
   * client's authorization request (an /auth/oauth/authorize path on this server;
   * never an arbitrary URL). Null for ordinary web-app logins.
   */
  returnTo: text("return_to"),
  createdAt: createdAt(),
});

/**
 * OAuth authorization codes issued to MCP clients (F12). Stored hashed and
 * single-use: `used_at` is set when exchanged, and a second exchange attempt
 * revokes every refresh token issued from the code (RFC 9700 code-reuse defence).
 */
export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    codeHash: text("code_hash").notNull(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    scope: text("scope").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  // The token endpoint looks codes up by hash.
  (table) => [uniqueIndex("oauth_codes_hash_uq").on(table.codeHash)],
);

/**
 * Refresh tokens issued to MCP clients. Stored hashed; rotated on every use.
 * All tokens descending from one authorization code share `family_id`, so
 * presenting an already-rotated token revokes the whole family (reuse detection).
 */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    tokenHash: text("token_hash").notNull(),
    familyId: integer("family_id")
      .notNull()
      .references(() => oauthAuthorizationCodes.id),
    clientId: text("client_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // Refresh requests look tokens up by hash.
    uniqueIndex("oauth_refresh_hash_uq").on(table.tokenHash),
    // Reuse detection revokes by family.
    index("oauth_refresh_family_idx").on(table.familyId),
  ],
);

/**
 * Server-side login sessions behind the httpOnly refresh cookie. Only the
 * SHA-256 hash of the cookie value is stored, so a database leak does not
 * leak usable sessions. `revoked_at` is set on logout instead of deleting.
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    tokenHash: text("token_hash").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // Every /auth/token call looks a session up by the hash of its cookie.
    uniqueIndex("auth_sessions_token_hash_idx").on(table.tokenHash),
    index("auth_sessions_user_id_idx").on(table.userId),
  ],
);

/**
 * Live update events (F11), streamed to browsers over Server-Sent Events.
 * Written in the same transaction as the change they announce, so an event is
 * never lost or invented. The identity `id` is the SSE event id: a reconnecting
 * client sends the last id it saw (Last-Event-ID) and receives exactly the
 * events after it. Rows older than the replay window are pruned.
 */
export const liveEvents = pgTable(
  "live_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  // Pruning deletes by age.
  (table) => [index("live_events_created_at_idx").on(table.createdAt)],
);

/**
 * Append-only audit trail (F6): who (actor from validated token), what (action +
 * entity), when, and before/after state as JSON snapshots.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: integer("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  // "History of this entity" queries filter by type + id.
  (table) => [index("audit_log_entity_idx").on(table.entityType, table.entityId)],
);

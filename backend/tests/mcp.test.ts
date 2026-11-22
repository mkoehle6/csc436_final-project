import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshAppWithDb, TEST_ISSUER, useTestSigningKey } from "./helpers.js";

/**
 * F12 phase 2: the /mcp endpoint, exercised with the official MCP client SDK
 * against a real HTTP server. Tokens are minted the way /auth/oauth/token mints
 * them (issueMcpAccessToken), so this tests the resource-server side.
 * Expected outcomes were predicted by hand before running.
 */

const CLIENT_ID = "https://client.example.test/oauth/metadata.json";

type Fresh = Awaited<ReturnType<typeof freshAppWithDb>>;
let db: Fresh["db"];
let close: Fresh["close"];
let schema: typeof import("../src/db/schema.js");
let server: Server;
let base: string;
const clients: Client[] = [];

beforeEach(async () => {
  await useTestSigningKey();
  const fresh = await freshAppWithDb();
  ({ db, close } = fresh);
  schema = await import("../src/db/schema.js");
  server = fresh.app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await new Promise((r) => server.close(r));
  await close();
});

async function user(role: "viewer" | "operator" = "viewer") {
  const [u] = await db.insert(schema.users).values({ oidcSubject: `sub-${Math.random()}`, email: `${role}${Math.random()}@example.com`, role }).returning();
  return u!;
}

async function mcpToken(userId: number, role: "viewer" | "operator", scope: string) {
  const { issueMcpAccessToken } = await import("../src/auth/tokens.js");
  return (await issueMcpAccessToken({ userId, role, scope, clientId: CLIENT_ID })).accessToken;
}

async function connect(token: string) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

/** Raw HTTP probe, to see status codes and challenge headers exactly as a client receives them. */
async function rawToolCall(token: string | undefined, name: string, args: Record<string, unknown> = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

const toolAudits = async () =>
  (
    await db.execute<{ after: { tool: string; outcome: string; clientId: string; args: Record<string, unknown> }; actor: number }>(
      sql`SELECT after, actor_user_id AS actor FROM audit_log WHERE action = 'mcp.tool_call' ORDER BY id`,
    )
  ).rows;

describe("authentication", () => {
  it("answers 401 with a resource_metadata challenge when no token is sent", async () => {
    const res = await rawToolCall(undefined, "get_leaderboard");
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${TEST_ISSUER}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("refuses a web-app token (wrong audience): no token passthrough", async () => {
    const u = await user();
    const { issueAccessToken } = await import("../src/auth/tokens.js");
    const webToken = (await issueAccessToken({ id: u.id, role: "viewer" })).accessToken;
    expect((await rawToolCall(webToken, "get_leaderboard")).status).toBe(401);
  });

  it("refuses a token with MCP-style claims but the web API's audience (audience check alone)", async () => {
    const u = await user();
    const { SignJWT } = await import("jose");
    const { getSigningKey } = await import("../src/auth/keys.js");
    const key = await getSigningKey();
    const wrongAudience = await new SignJWT({ role: "viewer", scope: "trivia:read", client_id: CLIENT_ID })
      .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "at+jwt" })
      .setIssuer(TEST_ISSUER)
      .setAudience("trivianerd-api") // valid signature, issuer, expiry and claims, wrong audience
      .setSubject(String(u.id))
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key.privateKey);
    expect((await rawToolCall(wrongAudience, "get_leaderboard")).status).toBe(401);
  });

  it("refuses an expired MCP token", async () => {
    const u = await user();
    const { SignJWT } = await import("jose");
    const { getSigningKey } = await import("../src/auth/keys.js");
    const key = await getSigningKey();
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ role: "viewer", scope: "trivia:read", client_id: CLIENT_ID })
      .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "at+jwt" })
      .setIssuer(TEST_ISSUER)
      .setAudience(`${TEST_ISSUER}/mcp`)
      .setSubject(String(u.id))
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(key.privateKey);
    expect((await rawToolCall(expired, "get_leaderboard")).status).toBe(401);
  });
});

describe("tools and scopes", () => {
  it("lists the six tools with read-only annotations on the read tools", async () => {
    const u = await user();
    const client = await connect(await mcpToken(u.id, "viewer", "trivia:read"));
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      "add_question",
      "get_leaderboard",
      "get_my_stats",
      "get_random_questions",
      "play_trivia",
      "submit_answer",
    ]);
    expect(byName.get_leaderboard!.annotations?.readOnlyHint).toBe(true);
    expect(byName.add_question!.annotations?.readOnlyHint).toBe(false);
  });

  it("a read token can call read tools; leaderboard shows nicknames only", async () => {
    const reader = await user();
    const other = await user();
    await db.insert(schema.gameSessions).values({ userId: other.id, score: 30 });
    const client = await connect(await mcpToken(reader.id, "viewer", "trivia:read"));

    const res = await client.callTool({ name: "get_leaderboard", arguments: {} });
    expect(res.isError).toBeFalsy();
    const board = (res.structuredContent as { leaderboard: Array<{ player: string; points: number }> }).leaderboard;
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ rank: 1, points: 30, player: expect.stringMatching(new RegExp(`#${other.id}$`)) });
    expect(JSON.stringify(res)).not.toContain("@example.com");
  });

  it("READ TOKEN REFUSED ON THE WRITE TOOL: 403 insufficient_scope naming questions:write, and audited", async () => {
    const op = await user("operator"); // even an operator, if the token only carries trivia:read
    const token = await mcpToken(op.id, "operator", "trivia:read");

    const res = await rawToolCall(token, "add_question", { prompt: "Who owns the Kwik-E-Mart?", correctAnswer: "Apu", wrongAnswers: ["Moe", "Ned", "Otto"] });
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="questions:write"');
    expect(challenge).toContain(`resource_metadata="${TEST_ISSUER}/.well-known/oauth-protected-resource/mcp"`);

    const audits = await toolAudits();
    expect(audits.map((a) => [a.actor, a.after.tool, a.after.outcome])).toEqual([[op.id, "add_question", "refused_insufficient_scope"]]);
    expect((await db.select().from(schema.questions)).length).toBe(0);
  });

  it("get_random_questions never includes the correct answer", async () => {
    await db.insert(schema.questions).values(
      Array.from({ length: 60 }, (_, i) => ({ prompt: `Q${i}?`, category: "character" as const, correctAnswer: "A", choices: ["A", "B", "C", "D"], imagePath: null, sourceEntityId: i })),
    );
    const u = await user();
    const client = await connect(await mcpToken(u.id, "viewer", "trivia:read"));
    const res = await client.callTool({ name: "get_random_questions", arguments: { count: 3 } });
    const qs = (res.structuredContent as { questions: Array<Record<string, unknown>> }).questions;
    expect(qs).toHaveLength(3);
    for (const q of qs) expect(q).not.toHaveProperty("correctAnswer");
  });

  it("get_my_stats returns only the caller's own results", async () => {
    const me = await user();
    const someoneElse = await user();
    const [q1, q2] = await db
      .insert(schema.questions)
      .values([1, 2].map((n) => ({ prompt: `S${n}?`, category: "character" as const, correctAnswer: "A", choices: ["A", "B", "C", "D"], imagePath: null, sourceEntityId: n })))
      .returning();
    const [mine] = await db.insert(schema.gameSessions).values({ userId: me.id, score: 10 }).returning();
    await db.insert(schema.answers).values([
      { sessionId: mine!.id, questionId: q1!.id, selectedAnswer: "A", isCorrect: true },
      { sessionId: mine!.id, questionId: q2!.id, selectedAnswer: "B", isCorrect: false },
    ]);
    await db.insert(schema.gameSessions).values({ userId: someoneElse.id, score: 90 });

    const client = await connect(await mcpToken(me.id, "viewer", "trivia:read"));
    const res = await client.callTool({ name: "get_my_stats", arguments: {} });
    // Hand-predicted: 1 game, 10 points, 1 of 2 correct = 50%.
    expect(res.structuredContent).toMatchObject({ games: 1, totalPoints: 10, answers: 2, correct: 1, accuracyPercent: 50 });
  });
});

describe("add_question: write with server-enforced confirmation", () => {
  const question = { prompt: "Who runs the Kwik-E-Mart?", correctAnswer: "Apu", wrongAnswers: ["Moe", "Ned", "Otto"] };

  it("creates nothing on the first call, then only with the right code, same payload, once", async () => {
    const op = await user("operator");
    const client = await connect(await mcpToken(op.id, "operator", "trivia:read questions:write"));

    const first = await client.callTool({ name: "add_question", arguments: question });
    const preview = first.structuredContent as { status: string; confirmationCode: string };
    expect(preview.status).toBe("confirmation_required");
    expect(preview.confirmationCode).toMatch(/^[A-Z2-9]{8}$/);
    expect((await db.select().from(schema.questions)).length).toBe(0); // nothing written yet

    const wrongCode = await client.callTool({ name: "add_question", arguments: { ...question, confirmationCode: "AAAAAAAA" } });
    expect(wrongCode.isError).toBe(true);

    const baitAndSwitch = await client.callTool({ name: "add_question", arguments: { ...question, correctAnswer: "Moe", wrongAnswers: ["Apu", "Ned", "Otto"], confirmationCode: preview.confirmationCode } });
    expect(baitAndSwitch.isError).toBe(true);
    expect(JSON.stringify(baitAndSwitch.content)).toContain("differs from what was confirmed");

    const confirmed = await client.callTool({ name: "add_question", arguments: { ...question, confirmationCode: preview.confirmationCode } });
    expect(confirmed.isError).toBeFalsy();
    expect(confirmed.structuredContent).toMatchObject({ status: "created" });
    const stored = await db.select().from(schema.questions);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ prompt: question.prompt, correctAnswer: "Apu" });

    const replay = await client.callTool({ name: "add_question", arguments: { ...question, confirmationCode: preview.confirmationCode } });
    expect(replay.isError).toBe(true); // used (and the prompt now exists anyway)

    const outcomes = (await toolAudits()).map((a) => a.after.outcome);
    expect(outcomes).toEqual(["confirmation_required", "error", "error", "ok", "error"]);
    expect((await toolAudits()).every((a) => a.after.args.confirmationCode === undefined || a.after.args.confirmationCode === "[redacted]")).toBe(true);
    const created = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "question.create"));
    expect(created).toHaveLength(1);
    expect(created[0]!.actorUserId).toBe(op.id);
  });

  it("another user's confirmation code does not work", async () => {
    const alice = await user("operator");
    const bob = await user("operator");
    const aliceClient = await connect(await mcpToken(alice.id, "operator", "questions:write"));
    const bobClient = await connect(await mcpToken(bob.id, "operator", "questions:write"));
    const { confirmationCode } = (await aliceClient.callTool({ name: "add_question", arguments: question })).structuredContent as { confirmationCode: string };
    const stolen = await bobClient.callTool({ name: "add_question", arguments: { ...question, confirmationCode } });
    expect(stolen.isError).toBe(true);
    expect((await db.select().from(schema.questions)).length).toBe(0);
  });

  it("re-checks the role at call time: a demoted operator's token cannot add questions", async () => {
    const op = await user("operator");
    const client = await connect(await mcpToken(op.id, "operator", "questions:write"));
    await db.update(schema.users).set({ role: "viewer" }).where(eq(schema.users.id, op.id));
    const res = await client.callTool({ name: "add_question", arguments: question });
    expect(res.isError).toBe(true);
    expect((await toolAudits()).at(-1)!.after.outcome).toBe("refused_role");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshAppWithDb, useTestSigningKey } from "./helpers.js";

/**
 * F13: the MCP App, from the server's side, with the official MCP client SDK.
 * The UI itself (mcp-app/) runs inside a host; here we verify everything the host
 * relies on: the tool → UI link, the UI resource, app-only visibility, and that
 * the app's calls are held to exactly the same authorization as any other call.
 * Expected outcomes were predicted by hand before running.
 */

const CLIENT_ID = "https://client.example.test/oauth/metadata.json";
const QUIZ_URI = "ui://trivianerd/quiz.html";

type Fresh = Awaited<ReturnType<typeof freshAppWithDb>>;
let app: Fresh["app"];
let db: Fresh["db"];
let close: Fresh["close"];
let schema: typeof import("../src/db/schema.js");
let server: Server;
let base: string;
const clients: Client[] = [];
let htmlDir: string;

beforeEach(async () => {
  // A stand-in for the built app, so the test does not depend on build order.
  htmlDir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-mcp-app-"));
  process.env.MCP_APP_HTML = path.join(htmlDir, "quiz.html");
  fs.writeFileSync(process.env.MCP_APP_HTML, "<!doctype html><html><body>TRIVIANERD-QUIZ-TEST</body></html>");

  await useTestSigningKey();
  const fresh = await freshAppWithDb();
  ({ app, db, close } = fresh);
  schema = await import("../src/db/schema.js");
  server = fresh.app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await db.insert(schema.questions).values(
    Array.from({ length: 60 }, (_, i) => ({
      prompt: `Question ${i}?`, category: "character" as const, correctAnswer: "Right", choices: ["Right", "W1", "W2", "W3"], imagePath: null, sourceEntityId: i,
    })),
  );
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await new Promise((r) => server.close(r));
  await close();
  delete process.env.MCP_APP_HTML;
  fs.rmSync(htmlDir, { recursive: true, force: true });
});

async function player(scope: string) {
  const [u] = await db.insert(schema.users).values({ oidcSubject: `sub-${Math.random()}`, email: `p${Math.random()}@example.com` }).returning();
  const { issueMcpAccessToken } = await import("../src/auth/tokens.js");
  const token = (await issueMcpAccessToken({ userId: u!.id, role: "viewer", scope, clientId: CLIENT_ID })).accessToken;
  const client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return { userId: u!.id, token, client };
}

function rawCall(token: string, method: string, params: Record<string, unknown>) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("MCP App wiring", () => {
  it("play_trivia links to the quiz UI; submit_answer is app-only", async () => {
    const { client } = await player("trivia:read trivia:play");
    const { tools } = await client.listTools();
    const play = tools.find((t) => t.name === "play_trivia")!;
    const submit = tools.find((t) => t.name === "submit_answer")!;
    expect(play._meta).toMatchObject({ ui: { resourceUri: QUIZ_URI }, "ui/resourceUri": QUIZ_URI });
    expect(submit._meta).toMatchObject({ ui: { visibility: ["app"] } });
  });

  it("serves the quiz as an MCP App resource: profile MIME type, image-only CSP, the built HTML", async () => {
    const { client } = await player("trivia:play");
    const res = await client.readResource({ uri: QUIZ_URI });
    const content = res.contents[0]!;
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect("text" in content ? content.text : "").toContain("TRIVIANERD-QUIZ-TEST");
    expect(content._meta).toEqual({ ui: { csp: { resourceDomains: ["https://cdn.thesimpsonsapi.com"] }, prefersBorder: true } });
    // No connectDomains: the app cannot make network calls of its own.
    expect(JSON.stringify(content._meta)).not.toContain("connectDomains");
  });
});

describe("the app respects the same authorization (F13)", () => {
  it("a read-only connection is refused (403 insufficient_scope) for play_trivia, submit_answer and the UI", async () => {
    const { token } = await player("trivia:read");
    for (const [method, params] of [
      ["tools/call", { name: "play_trivia", arguments: {} }],
      ["tools/call", { name: "submit_answer", arguments: { sessionId: 1, questionId: 1, selectedAnswer: "Right" } }],
      ["resources/read", { uri: QUIZ_URI }],
    ] as const) {
      const res = await rawCall(token, method, params);
      expect(res.status, `${method} ${JSON.stringify(params)}`).toBe(403);
      expect(res.headers.get("www-authenticate")).toContain('scope="trivia:play"');
    }
    expect(await db.select().from(schema.gameSessions)).toHaveLength(0);
  });

  it("an app cannot score answers in someone else's game", async () => {
    const owner = await player("trivia:play");
    const intruder = await player("trivia:play");
    const game = (await owner.client.callTool({ name: "play_trivia", arguments: { count: 1 } })).structuredContent as { sessionId: number; questions: Array<{ id: number }> };
    const res = await intruder.client.callTool({ name: "submit_answer", arguments: { sessionId: game.sessionId, questionId: game.questions[0]!.id, selectedAnswer: "Right" } });
    expect(res.isError).toBe(true);
    expect(await db.select().from(schema.answers)).toHaveLength(0);
  });
});

describe("a game played through the MCP App", () => {
  it("is scored on the server, audited as mcp, and shows on the website's live leaderboard", async () => {
    const { client, userId } = await player("trivia:read trivia:play");

    const started = await client.callTool({ name: "play_trivia", arguments: { count: 3 } });
    const game = started.structuredContent as { sessionId: number; player: string; questions: Array<{ id: number; choices: string[] }> };
    expect(game.questions).toHaveLength(3);
    for (const q of game.questions) expect(q).not.toHaveProperty("correctAnswer");
    expect(game.player).toMatch(new RegExp(`#${userId}$`));

    const [q1, q2] = game.questions;
    const right = await client.callTool({ name: "submit_answer", arguments: { sessionId: game.sessionId, questionId: q1!.id, selectedAnswer: "Right" } });
    expect(right.structuredContent).toMatchObject({ isCorrect: true, correctAnswer: "Right", score: { points: 10, correctCount: 1, totalCount: 1 } });
    const wrong = await client.callTool({ name: "submit_answer", arguments: { sessionId: game.sessionId, questionId: q2!.id, selectedAnswer: "W2" } });
    // Hand-predicted: 1 of 2 correct → still 10 points.
    expect(wrong.structuredContent).toMatchObject({ isCorrect: false, correctAnswer: "Right", score: { points: 10, totalCount: 2 } });

    const again = await client.callTool({ name: "submit_answer", arguments: { sessionId: game.sessionId, questionId: q1!.id, selectedAnswer: "W1" } });
    expect(again.isError).toBe(true); // already answered

    // Same pipeline as the web app: audit says via mcp, and the live leaderboard has the score.
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "answer.submit"));
    expect(audits.map((a) => (a.after as { via: string }).via)).toEqual(["mcp", "mcp"]);
    const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM live_events WHERE type = 'score'`);
    expect(rows[0]!.n).toBe(2);
    const board = await request(app).get("/api/leaderboard");
    expect(board.body.leaderboard).toEqual([{ rank: 1, player: game.player, points: 10, sessions: 1 }]);
  });
});

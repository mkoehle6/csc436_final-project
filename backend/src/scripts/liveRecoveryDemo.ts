/**
 * Kill-and-recover demo for the live leaderboard (F11), across a REAL server
 * restart (two separate processes sharing one database). Prints a transcript.
 *
 *   npm run demo:live-recovery            (runs both phases; see package.json)
 *
 * Phase 1: start the server, connect an SSE client, record one live event,
 *          drop the client, let two more events happen while it is away,
 *          then stop the server (all in-memory state is gone).
 * Phase 2: start a NEW server process on the same database; the client
 *          reconnects with Last-Event-ID and must receive exactly the two
 *          missed events, then a new live one: no gaps, no repeats.
 *
 * Uses a throwaway embedded database and signing key in a temp directory.
 */
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair } from "jose";

const [phase, dir] = process.argv.slice(2);
if ((phase !== "1" && phase !== "2") || !dir) {
  console.error("usage: liveRecoveryDemo.ts <1|2> <data-dir>");
  process.exit(2);
}
const statePath = path.join(dir, "demo-state.json");
type State = { jwk: string; token: string; sessionId: number; questionIds: number[]; lastEventId: string };

const say = (s: string) => console.log(`[phase ${phase}] ${s}`);

fs.mkdirSync(dir, { recursive: true });
process.env.DATABASE_URL = path.join(dir, "pglite");
let state: State | undefined = phase === "2" ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as State) : undefined;
process.env.AUTH_PRIVATE_JWK =
  state?.jwk ?? JSON.stringify({ ...(await exportJWK((await generateKeyPair("ES256", { extractable: true })).privateKey)), kid: "demo" });

const { db, runMigrations, closeDb } = await import("../db/client.js");
await runMigrations();
const { createApp } = await import("../app.js");
const { closeAllStreams } = await import("../routes/live.js");
const server = createApp().listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
say(`server process ${process.pid} listening on ${base}`);

/** Minimal SSE reader: prints and collects events until aborted. */
function listen(headers: Record<string, string>) {
  const controller = new AbortController();
  const seen: string[] = [];
  const done = (async () => {
    const res = await fetch(`${base}/api/live/leaderboard`, { headers: { Accept: "text/event-stream", ...headers }, signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        for (let i; (i = buf.indexOf("\n\n")) !== -1; ) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (.*)$/m.exec(block)?.[1];
          const type = /^event: (.*)$/m.exec(block)?.[1];
          if (id !== undefined && type) {
            seen.push(id);
            const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "{}") as { player?: string; sessionPoints?: number };
            say(`  client received  id=${id.padEnd(3)} ${type}${data.player ? `  ${data.player} → ${data.sessionPoints} pts` : ""}`);
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { seen, stop: () => controller.abort(), done };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
};

async function answer(s: State, questionId: number) {
  const res = await fetch(`${base}/api/sessions/${s.sessionId}/answers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ questionId, selectedAnswer: "A" }),
  });
  const body = (await res.json()) as { eventId: number };
  say(`answer submitted  → server created event id=${body.eventId}`);
}

if (phase === "1") {
  const schema = await import("../db/schema.js");
  const { issueAccessToken } = await import("../auth/tokens.js");
  const [user] = await db.insert(schema.users).values({ oidcSubject: "demo", email: "demo@example.invalid" }).returning();
  const qs = await db
    .insert(schema.questions)
    .values([1, 2, 3, 4].map((n) => ({ prompt: `Demo ${n}?`, category: "character" as const, correctAnswer: "A", choices: ["A", "B", "C", "D"], sourceEntityId: n })))
    .returning({ id: schema.questions.id });
  const token = (await issueAccessToken({ id: user!.id, role: "viewer" })).accessToken;
  const session = (await fetch(`${base}/api/sessions`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())) as { id: number };
  state = { jwk: process.env.AUTH_PRIVATE_JWK, token, sessionId: session.id, questionIds: qs.map((q) => q.id), lastEventId: "" };

  const client = listen({});
  await until(() => client.seen.length >= 1);
  await answer(state, state.questionIds[0]!);
  await until(() => client.seen.length >= 2);
  client.stop();
  state.lastEventId = client.seen.at(-1)!;
  say(`client DISCONNECTED (last id it saw: ${state.lastEventId})`);
  await answer(state, state.questionIds[1]!);
  await answer(state, state.questionIds[2]!);
  fs.writeFileSync(statePath, JSON.stringify(state));
} else {
  const s = state!;
  say(`client RECONNECTS with Last-Event-ID: ${s.lastEventId}`);
  const client = listen({ "Last-Event-ID": s.lastEventId });
  await until(() => client.seen.length >= 2);
  await answer(s, s.questionIds[3]!);
  await until(() => client.seen.length >= 3);
  client.stop();
  const expected = [Number(s.lastEventId) + 1, Number(s.lastEventId) + 2, Number(s.lastEventId) + 3].map(String);
  const ok = JSON.stringify(client.seen) === JSON.stringify(expected);
  say(`received after restart: [${client.seen.join(", ")}]  expected: [${expected.join(", ")}]  → ${ok ? "PASS: nothing lost, nothing repeated" : "FAIL"}`);
  process.exitCode = ok ? 0 : 1;
}

closeAllStreams();
await new Promise((r) => server.close(r));
await closeDb();
say(`server process ${process.pid} STOPPED (in-memory state gone)`);

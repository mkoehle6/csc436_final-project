import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshAppWithDb, useTestSigningKey } from "./helpers.js";

/**
 * F11: live leaderboard over SSE, against a real HTTP server (streams need one).
 * Expected ids/values were predicted by hand: events are numbered 1, 2, 3, …
 * in commit order; the snapshot carries the newest id at connect time.
 */

interface SseEvent {
  id: string | undefined;
  event: string;
  data: unknown;
}

type Fresh = Awaited<ReturnType<typeof freshAppWithDb>>;
let db: Fresh["db"];
let close: Fresh["close"];
let schema: typeof import("../src/db/schema.js");
let server: Server;
let base: string;
const streams: Array<{ abort: () => void }> = [];

/** Opens an SSE stream and collects parsed events; resolves once headers arrive. */
async function openStream(opts: { lastEventId?: string; query?: string } = {}) {
  const controller = new AbortController();
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (opts.lastEventId !== undefined) headers["Last-Event-ID"] = opts.lastEventId;
  const res = await fetch(`${base}/api/live/leaderboard${opts.query ?? ""}`, { headers, signal: controller.signal });

  const events: SseEvent[] = [];
  let ended = false;
  const waiters: Array<() => void> = [];
  const wake = () => waiters.splice(0).forEach((w) => w());

  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const fields: Record<string, string> = {};
            for (const line of block.split("\n")) {
              if (!line || line.startsWith(":")) continue; // comment / heartbeat
              const i = line.indexOf(":");
              fields[line.slice(0, i)] = line.slice(i + 1).trimStart();
            }
            if (fields.data !== undefined) {
              events.push({ id: fields.id, event: fields.event ?? "message", data: JSON.parse(fields.data) });
              wake();
            }
          }
        }
      } catch {
        // aborted
      } finally {
        ended = true;
        wake();
      }
    })();
  }

  const handle = {
    res,
    events,
    get ended() {
      return ended;
    },
    abort: () => controller.abort(),
    /** Waits until `n` events have arrived (or the stream ends / times out). */
    async waitFor(n: number, ms = 5000) {
      const deadline = Date.now() + ms;
      while (events.length < n && !ended && Date.now() < deadline) {
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
      return events;
    },
  };
  streams.push(handle);
  return handle;
}

async function seedQuestions(n: number) {
  return db
    .insert(schema.questions)
    .values(
      Array.from({ length: n }, (_, i) => ({
        prompt: `Q${i}?`, category: "character" as const, correctAnswer: "A", choices: ["A", "B", "C", "D"], imagePath: null, sourceEntityId: i + 1,
      })),
    )
    .returning({ id: schema.questions.id });
}

async function player(email: string) {
  const [user] = await db.insert(schema.users).values({ oidcSubject: `sub-${email}`, email }).returning({ id: schema.users.id });
  const { issueAccessToken } = await import("../src/auth/tokens.js");
  const auth = `Bearer ${(await issueAccessToken({ id: user!.id, role: "viewer" })).accessToken}`;
  const session = (await fetch(`${base}/api/sessions`, { method: "POST", headers: { Authorization: auth } }).then((r) =>
    r.json(),
  )) as { id: number };
  const answer = (questionId: number, selectedAnswer: string) =>
    fetch(`${base}/api/sessions/${session.id}/answers`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, selectedAnswer }),
    });
  return { userId: user!.id, answer };
}

const ids = (events: SseEvent[]) => events.map((e) => e.id);

beforeEach(async () => {
  await useTestSigningKey();
  const fresh = await freshAppWithDb();
  ({ db, close } = fresh);
  schema = await import("../src/db/schema.js");
  server = fresh.app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const s of streams.splice(0)) s.abort();
  const { closeAllStreams } = await import("../src/routes/live.js");
  closeAllStreams();
  await new Promise((r) => server.close(r));
  await close();
});

describe("SSE live leaderboard", () => {
  it("sends a snapshot on connect, then each answer as an ordered event (nicknames only)", async () => {
    const [q1, q2] = await seedQuestions(2);
    const bart = await player("bart@example.com");
    const stream = await openStream();

    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.res.headers.get("cache-control")).toBe("no-store, no-transform");
    const [snapshot] = await stream.waitFor(1);
    expect(snapshot).toMatchObject({ id: "0", event: "snapshot", data: { leaderboard: [], lastEventId: 0 } });

    await bart.answer(q1!.id, "A"); // correct → 10 points
    await bart.answer(q2!.id, "B"); // wrong
    const events = await stream.waitFor(3);
    expect(ids(events)).toEqual(["0", "1", "2"]);
    expect(events[1]).toMatchObject({ event: "score", data: { isCorrect: true, sessionPoints: 10 } });
    expect(events[2]).toMatchObject({ event: "score", data: { isCorrect: false, sessionPoints: 10 } });

    const board = (events[2]!.data as { leaderboard: Array<{ player: string; points: number }> }).leaderboard;
    expect(board).toEqual([{ rank: 1, player: expect.stringMatching(new RegExp(`#${bart.userId}$`)), points: 10, sessions: 1 }]);
    expect(JSON.stringify(events)).not.toContain("@example.com"); // no real identity in public events
  });

  it("kill and recover: a client that reconnects with Last-Event-ID gets exactly what it missed", async () => {
    const qs = await seedQuestions(3);
    const lisa = await player("lisa@example.com");

    const first = await openStream();
    const [snap] = await first.waitFor(1);
    const lastSeen = snap!.id!; // "0"
    first.abort(); // connection killed

    await lisa.answer(qs[0]!.id, "A"); // event 1, missed
    await lisa.answer(qs[1]!.id, "A"); // event 2, missed

    const resumed = await openStream({ lastEventId: lastSeen });
    await resumed.waitFor(2);
    await lisa.answer(qs[2]!.id, "A"); // event 3, live
    const events = await resumed.waitFor(3);

    // Hand-predicted: no snapshot on resume; missed 1 and 2, then live 3; no gaps, no repeats.
    expect(events.map((e) => [e.id, e.event])).toEqual([
      ["1", "score"],
      ["2", "score"],
      ["3", "score"],
    ]);
    expect((events[2]!.data as { sessionPoints: number }).sessionPoints).toBe(30);
  });

  it("server-side kill (as on deploy/shutdown) ends streams; resuming via ?lastEventId= loses nothing", async () => {
    const qs = await seedQuestions(2);
    const moe = await player("moe@example.com");
    const stream = await openStream();
    await stream.waitFor(1);
    await moe.answer(qs[0]!.id, "A");
    await stream.waitFor(2);

    const { closeAllStreams } = await import("../src/routes/live.js");
    closeAllStreams(); // what graceful shutdown does
    await stream.waitFor(99, 2000);
    expect(stream.ended).toBe(true);

    await moe.answer(qs[1]!.id, "A"); // happens while the client is disconnected
    const resumed = await openStream({ query: `?lastEventId=${stream.events.at(-1)!.id}` });
    const events = await resumed.waitFor(1);
    expect(ids(events)).toEqual(["2"]);
  });

  it("falls back to a snapshot when the client's position is unknown or too old", async () => {
    const [q] = await seedQuestions(1);
    const ned = await player("ned@example.com");
    await ned.answer(q!.id, "A"); // event 1

    const ahead = await openStream({ lastEventId: "999" }); // e.g. after a database reset
    expect((await ahead.waitFor(1))[0]).toMatchObject({ event: "snapshot", id: "1" });

    await db.execute(sql`DELETE FROM live_events`); // replay window pruned
    await db.execute(sql`INSERT INTO live_events (type, payload) VALUES ('score', '{}'), ('score', '{}')`); // ids 2, 3
    const stale = await openStream({ lastEventId: "0" }); // event 1 is gone: cannot replay faithfully
    expect((await stale.waitFor(1))[0]).toMatchObject({ event: "snapshot", id: "3" });

    const garbage = await openStream({ lastEventId: "not-a-number" });
    expect((await garbage.waitFor(1))[0]).toMatchObject({ event: "snapshot" });
  });

  it("keeps ids contiguous and ordered when answers arrive concurrently", async () => {
    const qs = await seedQuestions(8);
    const players = await Promise.all(["a", "b", "c", "d"].map((p) => player(`${p}@example.com`)));
    const stream = await openStream();
    await stream.waitFor(1);

    await Promise.all(players.flatMap((p, i) => [p.answer(qs[i * 2]!.id, "A"), p.answer(qs[i * 2 + 1]!.id, "A")]));
    const events = await stream.waitFor(9);
    expect(ids(events)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("never sends an event twice when several wake-ups arrive at once", async () => {
    const stream = await openStream();
    await stream.waitFor(1);
    await db.execute(sql`INSERT INTO live_events (type, payload) VALUES ('score', '{}'), ('score', '{}'), ('score', '{}')`);

    const { notifyNewEvents } = await import("../src/live/events.js");
    for (let i = 0; i < 5; i++) notifyNewEvents(); // five overlapping drains

    const events = await stream.waitFor(99, 1500);
    expect(ids(events)).toEqual(["0", "1", "2", "3"]);
  });

  it("caps open streams per client (429 for the 6th)", async () => {
    for (let i = 0; i < 5; i++) expect((await openStream()).res.status).toBe(200);
    const sixth = await openStream();
    expect(sixth.res.status).toBe(429);
  });

  it("GET /api/leaderboard is a briefly cacheable public snapshot", async () => {
    const res = await fetch(`${base}/api/leaderboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=5, s-maxage=10");
    expect(await res.json()).toEqual({ leaderboard: [], lastEventId: 0 });
  });
});

describe("nicknames", () => {
  it("are stable, unique per user and contain no personal data", async () => {
    const { nicknameFor } = await import("../src/live/nickname.js");
    expect(nicknameFor(7)).toBe(nicknameFor(7));
    const names = new Set(Array.from({ length: 200 }, (_, i) => nicknameFor(i + 1)));
    expect(names.size).toBe(200);
    expect(nicknameFor(42)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ #42$/);
  });
});

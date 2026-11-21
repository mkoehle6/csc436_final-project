import { Router, type Request, type Response } from "express";
import { db } from "../db/client.js";
import { ApiErrors } from "../lib/errors.js";
import { eventsAfter, latestEventId, MAX_BATCH, oldestEventId, onNewEvents } from "../live/events.js";
import { leaderboard } from "../live/leaderboard.js";

/**
 * Live leaderboard (F11) over Server-Sent Events.
 *
 * Why SSE rather than WebSockets: updates flow one way (server → browser);
 * SSE is plain HTTPS, so Render, the CDN and the CORS allowlist treat it like
 * any GET; and the browser's EventSource reconnects by itself, sending the last
 * event id it received (Last-Event-ID) — exactly what "reconnect without losing
 * or duplicating events" needs, with no extra library.
 *
 * Protocol:
 *   - new client (or one too far behind): `event: snapshot` carrying the current
 *     leaderboard, with `id:` = the newest event id at that moment;
 *   - reconnecting client (Last-Event-ID header, or ?lastEventId= for manual
 *     reconnects): every stored event after that id, in order, then live ones;
 *   - each change: `event: score`, `id:` = its database id;
 *   - `: ping` comments every 25 s keep proxies from closing idle streams.
 */
export const liveRouter = Router();

const HEARTBEAT_MS = 25_000;
/** Fallback re-read, in case a wake-up is ever missed (cheap: indexed range scan). */
const SAFETY_POLL_MS = 10_000;
/** Connection caps protect the single instance from being exhausted by open streams. */
const MAX_STREAMS_PER_IP = 5;
const MAX_STREAMS_TOTAL = 200;

const openStreams = new Set<Response>();
const streamsPerIp = new Map<string, number>();

/** Ends every open stream; clients reconnect (to the next instance) and resume. */
export function closeAllStreams(): void {
  for (const res of openStreams) res.end();
}

function parseLastEventId(req: Request): number | undefined {
  const raw = req.header("last-event-id") ?? (typeof req.query.lastEventId === "string" ? req.query.lastEventId : undefined);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** GET /api/leaderboard — public snapshot; identical for everyone, so briefly cacheable (D6). */
liveRouter.get("/leaderboard", async (_req, res, next) => {
  try {
    const lastEventId = await latestEventId(db);
    res.setHeader("Cache-Control", "public, max-age=5, s-maxage=10");
    res.status(200).json({ leaderboard: await leaderboard(db), lastEventId });
  } catch (err) {
    next(err);
  }
});

/** GET /api/live/leaderboard — the SSE stream. */
liveRouter.get("/live/leaderboard", async (req, res, next) => {
  const ip = req.ip ?? "unknown";
  if (openStreams.size >= MAX_STREAMS_TOTAL || (streamsPerIp.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) {
    next(ApiErrors.tooManyRequests("Too many open live connections"));
    return;
  }

  let cursor: number;
  let initial: string;
  try {
    // Read the newest id BEFORE the leaderboard: an event committing in between is
    // then also sent as an update (harmless, each carries the full board) rather
    // than being folded into the snapshot and skipped.
    const latest = await latestEventId(db);
    const requested = parseLastEventId(req);
    const oldest = await oldestEventId(db);
    const canResume =
      requested !== undefined && requested <= latest && (oldest === null || requested >= oldest - 1);

    if (canResume) {
      cursor = requested;
      initial = "";
    } else {
      cursor = latest;
      const data = JSON.stringify({ leaderboard: await leaderboard(db), lastEventId: latest });
      initial = `id: ${latest}\nevent: snapshot\ndata: ${data}\n\n`;
    }
  } catch (err) {
    next(err);
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform"); // never cache or buffer a stream
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n"); // reconnect delay hint for EventSource
  if (initial) res.write(initial);

  openStreams.add(res);
  streamsPerIp.set(ip, (streamsPerIp.get(ip) ?? 0) + 1);

  // Send everything after the cursor, in order. Serialised so two wake-ups can
  // never send the same event twice or out of order.
  let draining = false;
  let again = false;
  let closed = false;
  const drain = async () => {
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    try {
      do {
        again = false;
        const batch = await eventsAfter(db, cursor);
        for (const event of batch) {
          if (closed) return;
          res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
          cursor = event.id;
        }
        if (batch.length === MAX_BATCH) again = true;
      } while (again && !closed);
    } catch (err) {
      req.log.warn({ err }, "live stream read failed; client will reconnect");
      res.end();
    } finally {
      draining = false;
    }
  };

  const unsubscribe = onNewEvents(() => void drain());
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  const safetyPoll = setInterval(() => void drain(), SAFETY_POLL_MS);
  void drain(); // replay (resume) or catch anything committed since the snapshot

  req.on("close", () => {
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    clearInterval(safetyPoll);
    openStreams.delete(res);
    const n = (streamsPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) streamsPerIp.delete(ip);
    else streamsPerIp.set(ip, n);
  });
});

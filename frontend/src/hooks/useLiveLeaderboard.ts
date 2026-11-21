import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "../api/client";

export interface LeaderboardEntry {
  rank: number;
  player: string;
  points: number;
  sessions: number;
}

export interface Activity {
  id: number;
  player: string;
  isCorrect: boolean;
  sessionPoints: number;
}

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

const MAX_ACTIVITY = 5;
/** After this many failed manual reconnects in a row, show "offline" (still retrying slowly). */
const OFFLINE_AFTER = 4;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isLeaderboard(v: unknown): v is LeaderboardEntry[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        isRecord(e) &&
        typeof e.rank === "number" &&
        typeof e.player === "string" &&
        typeof e.points === "number" &&
        typeof e.sessions === "number",
    )
  );
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Live leaderboard over Server-Sent Events (F11).
 *
 * EventSource reconnects by itself and sends Last-Event-ID, so the server
 * replays exactly the missed events. If the browser gives up (e.g. an HTTP
 * error), this hook reconnects with exponential backoff and passes the last
 * id explicitly (?lastEventId=). Events at or below the last id seen are
 * ignored, so nothing is applied twice.
 */
export function useLiveLeaderboard() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[] | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [reconnectToken, setReconnectToken] = useState(0);
  const lastId = useRef<number | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let failures = 0;
    let disposed = false;

    const apply = (event: MessageEvent<string>, isSnapshot: boolean) => {
      const id = Number(event.lastEventId);
      if (!Number.isInteger(id)) return;
      // A snapshot resets the position; an update at or below it was already applied.
      if (!isSnapshot && lastId.current !== null && id <= lastId.current) return;

      const data = parse(event.data);
      if (!isRecord(data) || !isLeaderboard(data.leaderboard)) return;
      lastId.current = id;
      setLeaderboard(data.leaderboard);

      if (!isSnapshot && typeof data.player === "string" && typeof data.isCorrect === "boolean" && typeof data.sessionPoints === "number") {
        const entry: Activity = { id, player: data.player, isCorrect: data.isCorrect, sessionPoints: data.sessionPoints };
        setActivity((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY));
      }
    };

    const connect = () => {
      if (disposed) return;
      const url = new URL(`${API_BASE_URL}/api/live/leaderboard`);
      if (lastId.current !== null) url.searchParams.set("lastEventId", String(lastId.current));
      source = new EventSource(url);

      source.onopen = () => {
        failures = 0;
        setStatus("live");
      };
      source.addEventListener("snapshot", (e) => apply(e, true));
      source.addEventListener("score", (e) => apply(e, false));
      source.onerror = () => {
        if (!source || source.readyState !== EventSource.CLOSED) {
          setStatus("reconnecting"); // the browser is retrying on its own, with Last-Event-ID
          return;
        }
        // The browser gave up: retry ourselves, backing off up to 30 s.
        source.close();
        failures += 1;
        setStatus(failures >= OFFLINE_AFTER ? "offline" : "reconnecting");
        retryTimer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** (failures - 1)));
      };
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [reconnectToken]);

  /** Manual retry from the offline state. */
  const retry = useCallback(() => {
    setStatus("connecting");
    setReconnectToken((t) => t + 1);
  }, []);

  return { leaderboard, activity, status, retry };
}

import { useCallback, useRef, useState } from "react";
import { checkAnswer, startSession, submitAnswer } from "../api/client";
import type { AnswerResult, ScoreResult } from "../types/trivia";

/** Every answer is a remote call, so each one has visible pending/error/done states (F2). */
export type AnswerState =
  | { status: "pending"; selected: string }
  | { status: "error"; selected: string; message: string }
  | { status: "done"; result: AnswerResult };

interface SessionRef {
  userId: number;
  id: Promise<number>;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

/**
 * Game state for one round. The server always decides right/wrong:
 *  - signed out → POST /api/questions/:id/check (nothing saved)
 *  - signed in  → a game session is started on the first answer, and each
 *                 answer is recorded and scored server-side.
 */
export function useGame(userId: number | null, getAccessToken: () => Promise<string | null>) {
  const [answers, setAnswers] = useState<Map<number, AnswerState>>(new Map());
  const [score, setScore] = useState<ScoreResult | null>(null);
  // Shared promise, so two quick answers never start two sessions.
  const session = useRef<SessionRef | null>(null);

  const setAnswer = (questionId: number, state: AnswerState) =>
    setAnswers((prev) => new Map(prev).set(questionId, state));

  const ensureSession = useCallback(async (token: string, forUser: number) => {
    if (!session.current || session.current.userId !== forUser) {
      const id = startSession(token);
      session.current = { userId: forUser, id };
      setScore(null);
      id.catch(() => {
        if (session.current?.id === id) session.current = null; // let the next attempt retry
      });
    }
    return session.current.id;
  }, []);

  const answer = useCallback(
    async (questionId: number, selected: string) => {
      setAnswer(questionId, { status: "pending", selected });
      try {
        let result: AnswerResult;
        if (userId === null) {
          result = await checkAnswer(questionId, selected);
        } else {
          const token = await getAccessToken();
          if (!token) throw new Error("Your sign-in has expired. Sign in again to keep scoring.");
          const sessionId = await ensureSession(token, userId);
          result = await submitAnswer(token, sessionId, questionId, selected);
          setScore(result.score);
        }
        setAnswer(questionId, { status: "done", result });
      } catch (err) {
        setAnswer(questionId, { status: "error", selected, message: errorMessage(err) });
      }
    },
    [userId, getAccessToken, ensureSession],
  );

  /** Clears the round; the next signed-in answer starts a new session. */
  const reset = useCallback(() => {
    setAnswers(new Map());
    setScore(null);
    session.current = null;
  }, []);

  return { answers, score, answer, reset };
}

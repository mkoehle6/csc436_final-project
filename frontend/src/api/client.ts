import type { AnswerResult, ApiErrorBody, QuestionRound, ScoreResult, TriviaQuestion } from "../types/trivia";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return false;
  const e = error as Record<string, unknown>;
  return typeof e.code === "string" && typeof e.message === "string";
}

// ── Runtime validation: never trust a response's shape (the server is a remote system too).

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isTriviaQuestion(value: unknown): value is TriviaQuestion {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.prompt === "string" &&
    (value.category === "character" || value.category === "episode" || value.category === "location") &&
    Array.isArray(value.choices) &&
    value.choices.every((c) => typeof c === "string") &&
    (value.imagePath === null || typeof value.imagePath === "string")
  );
}

function isScoreResult(value: unknown): value is ScoreResult {
  return (
    isRecord(value) &&
    typeof value.correctCount === "number" &&
    typeof value.totalCount === "number" &&
    typeof value.percentage === "number" &&
    typeof value.points === "number"
  );
}

function hasVerdict(value: unknown): value is { isCorrect: boolean; correctAnswer: string } {
  return isRecord(value) && typeof value.isCorrect === "boolean" && typeof value.correctAnswer === "string";
}

const invalidResponse = () =>
  new ApiRequestError(502, "INVALID_RESPONSE", "The trivia server returned an unexpected response.");

async function request(path: string, init?: RequestInit & { token?: string }): Promise<unknown> {
  const { token, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
    });
  } catch {
    throw new ApiRequestError(0, "NETWORK_ERROR", "Could not reach the trivia server.");
  }

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiRequestError(res.status, body.error.code, body.error.message);
    }
    throw new ApiRequestError(res.status, "UNKNOWN_ERROR", `Request failed with status ${res.status}`);
  }
  return body;
}

/** A random round from the server's question bank (answers not included). */
export async function fetchQuestions(count = 9): Promise<QuestionRound> {
  const data = await request(`/api/questions?count=${count}`);
  if (!isRecord(data) || !Array.isArray(data.questions)) throw invalidResponse();
  const questions = data.questions.filter(isTriviaQuestion);
  if (questions.length === 0 && data.questions.length > 0) throw invalidResponse();
  return { questions, degraded: data.degraded === true };
}

/** Anonymous play: asks the server whether a choice is right. Nothing is saved. */
export async function checkAnswer(questionId: number, selectedAnswer: string): Promise<AnswerResult> {
  const data = await request(`/api/questions/${questionId}/check`, {
    method: "POST",
    body: JSON.stringify({ selectedAnswer }),
  });
  if (!hasVerdict(data)) throw invalidResponse();
  return { selectedAnswer, isCorrect: data.isCorrect, correctAnswer: data.correctAnswer, score: null };
}

/** Signed-in play: starts a scored game session. */
export async function startSession(token: string): Promise<number> {
  const data = await request("/api/sessions", { method: "POST", token });
  if (!isRecord(data) || typeof data.id !== "number") throw invalidResponse();
  return data.id;
}

/** Signed-in play: records an answer in the session; the server scores it. */
export async function submitAnswer(
  token: string,
  sessionId: number,
  questionId: number,
  selectedAnswer: string,
): Promise<AnswerResult> {
  const data = await request(`/api/sessions/${sessionId}/answers`, {
    method: "POST",
    token,
    body: JSON.stringify({ questionId, selectedAnswer }),
  });
  const score = isRecord(data) ? data.score : undefined;
  if (!hasVerdict(data) || !isScoreResult(score)) throw invalidResponse();
  return { selectedAnswer, isCorrect: data.isCorrect, correctAnswer: data.correctAnswer, score };
}

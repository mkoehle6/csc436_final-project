import type { ApiErrorBody, TriviaQuestion } from "../types/trivia";

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

function isTriviaQuestion(value: unknown): value is TriviaQuestion {
  if (typeof value !== "object" || value === null) return false;
  const q = value as Record<string, unknown>;
  return (
    typeof q.id === "number" &&
    typeof q.prompt === "string" &&
    typeof q.category === "string" &&
    typeof q.correctAnswer === "string" &&
    Array.isArray(q.choices) &&
    q.choices.every((c) => typeof c === "string")
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
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

  return body as T;
}

/** Fetches a fresh round of trivia questions; validates each item's runtime shape (F10). */
export async function fetchQuestions(count = 5): Promise<TriviaQuestion[]> {
  const data = await request<{ questions: unknown[] }>(`/api/questions?count=${count}`);
  const questions = data.questions.filter(isTriviaQuestion);
  if (questions.length === 0 && data.questions.length > 0) {
    throw new ApiRequestError(502, "INVALID_RESPONSE", "Trivia server returned malformed questions.");
  }
  return questions;
}

export type QuestionCategory = "character" | "episode" | "location";

export type Role = "viewer" | "operator";

/** The signed-in user, as returned by POST /auth/token. */
export interface AuthUser {
  id: number;
  email: string;
  displayName: string | null;
  role: Role;
}

/** A question as the server sends it: the correct answer is never included. */
export interface TriviaQuestion {
  id: number;
  prompt: string;
  category: QuestionCategory;
  choices: string[];
  imagePath: string | null;
}

export interface QuestionRound {
  questions: TriviaQuestion[];
  /** True when the server served saved questions because The Simpsons API was down. */
  degraded: boolean;
}

/** Server-side score of a game session (backend/src/lib/scoring.ts). */
export interface ScoreResult {
  correctCount: number;
  totalCount: number;
  percentage: number;
  points: number;
}

/** The server's verdict on one answer, revealed only after the player chooses. */
export interface AnswerResult {
  selectedAnswer: string;
  isCorrect: boolean;
  correctAnswer: string;
  /** Running session score when signed in; null for anonymous checks. */
  score: ScoreResult | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

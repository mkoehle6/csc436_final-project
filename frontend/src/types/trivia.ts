export type QuestionCategory = "character" | "episode" | "location";

export type Role = "viewer" | "operator";

/** The signed-in user, as returned by POST /auth/token. */
export interface AuthUser {
  id: number;
  email: string;
  displayName: string | null;
  role: Role;
}

export interface TriviaQuestion {
  id: number;
  prompt: string;
  category: QuestionCategory;
  correctAnswer: string;
  choices: string[];
  imagePath: string | null;
  sourceEntityId: number;
  createdAt: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

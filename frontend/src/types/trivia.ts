export type QuestionCategory = "character" | "episode" | "location";

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

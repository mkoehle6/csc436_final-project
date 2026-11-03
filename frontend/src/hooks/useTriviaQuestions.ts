import { useCallback, useEffect, useState } from "react";
import { fetchQuestions } from "../api/client";
import type { TriviaQuestion } from "../types/trivia";

export type TriviaQuestionsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | { status: "ready"; questions: TriviaQuestion[] };

/** Loads a round of trivia questions and exposes loading/empty/error/ready states (F2). */
export function useTriviaQuestions(count = 9) {
  const [state, setState] = useState<TriviaQuestionsState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetchQuestions(count)
      .then((questions) => {
        if (cancelled) return;
        setState(questions.length === 0 ? { status: "empty" } : { status: "ready", questions });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Something went wrong.";
        setState({ status: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [count, reloadToken]);

  return { state, reload };
}

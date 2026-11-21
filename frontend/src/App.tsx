import { useMemo, useState } from "react";
import "./App.css";
import { useAuth } from "./auth/authContext";
import { Header } from "./components/Header";
import { Leaderboard } from "./components/Leaderboard";
import { QuestionList } from "./components/QuestionList";
import { QuizPanel } from "./components/QuizPanel";
import { ScoreBar } from "./components/ScoreBar";
import { EmptyState, ErrorState, LoadingState } from "./components/StatusStates";
import { useGame } from "./hooks/useGame";
import { useTriviaQuestions } from "./hooks/useTriviaQuestions";
import type { QuestionCategory, TriviaQuestion } from "./types/trivia";

const NO_QUESTIONS: TriviaQuestion[] = [];

function App() {
  const { state, reload } = useTriviaQuestions(9);
  const { state: auth, getAccessToken } = useAuth();
  const userId = auth.status === "authenticated" ? auth.user.id : null;
  const game = useGame(userId, getAccessToken);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<QuestionCategory | "all">("all");
  const [activeId, setActiveId] = useState<number | null>(null);

  const questions = state.status === "ready" ? state.questions : NO_QUESTIONS;

  const filteredQuestions = useMemo(() => {
    const term = search.toLowerCase();
    return questions.filter(
      (q) => (category === "all" || q.category === category) && q.prompt.toLowerCase().includes(term),
    );
  }, [questions, category, search]);

  const activeQuestion = filteredQuestions.find((q) => q.id === activeId) ?? filteredQuestions[0] ?? null;

  const answeredIds = useMemo(
    () => new Set([...game.answers].filter(([, a]) => a.status === "done").map(([id]) => id)),
    [game.answers],
  );
  const correctCount = [...game.answers.values()].filter((a) => a.status === "done" && a.result.isCorrect).length;

  const newRound = () => {
    game.reset();
    setActiveId(null);
    reload();
  };

  return (
    <div className="app-shell">
      <Header search={search} onSearchChange={setSearch} category={category} onCategoryChange={setCategory} />

      <main className="app-main">
        <aside className="app-sidebar">
          {state.status === "loading" && <LoadingState />}
          {state.status === "error" && <ErrorState message={state.message} onRetry={reload} />}
          {state.status === "ready" && (
            <ScoreBar
              signedIn={userId !== null}
              score={game.score}
              answered={answeredIds.size}
              correct={correctCount}
              degraded={state.degraded}
              onNewRound={newRound}
            />
          )}
          {state.status !== "loading" && state.status !== "error" && (
            <QuestionList
              questions={filteredQuestions}
              activeId={activeQuestion?.id ?? null}
              onSelect={setActiveId}
              answeredIds={answeredIds}
            />
          )}
          <Leaderboard />
        </aside>

        <section className="app-content">
          {state.status === "loading" && <LoadingState />}
          {state.status === "error" && <ErrorState message={state.message} onRetry={reload} />}
          {state.status === "empty" && <EmptyState onRetry={reload} />}
          {state.status === "ready" && !activeQuestion && <EmptyState onRetry={reload} />}
          {state.status === "ready" && activeQuestion && (
            <QuizPanel
              key={activeQuestion.id}
              question={activeQuestion}
              answer={game.answers.get(activeQuestion.id)}
              onAnswer={(choice) => void game.answer(activeQuestion.id, choice)}
            />
          )}
        </section>
      </main>
    </div>
  );
}

export default App;

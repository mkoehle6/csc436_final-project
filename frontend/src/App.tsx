import { useMemo, useState } from "react";
import "./App.css";
import { Header } from "./components/Header";
import { QuestionList } from "./components/QuestionList";
import { QuizPanel } from "./components/QuizPanel";
import { EmptyState, ErrorState, LoadingState } from "./components/StatusStates";
import { useTriviaQuestions } from "./hooks/useTriviaQuestions";
import type { QuestionCategory } from "./types/trivia";

function App() {
  const { state, reload } = useTriviaQuestions(9);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<QuestionCategory | "all">("all");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Map<number, string>>(new Map());

  const questions = state.status === "ready" ? state.questions : [];

  const filteredQuestions = useMemo(() => {
    return questions.filter((q) => {
      const matchesCategory = category === "all" || q.category === category;
      const matchesSearch = q.prompt.toLowerCase().includes(search.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [questions, category, search]);

  const activeQuestion =
    filteredQuestions.find((q) => q.id === activeId) ?? filteredQuestions[0] ?? null;

  const handleAnswered = (questionId: number, selected: string) => {
    setAnswers((prev) => new Map(prev).set(questionId, selected));
  };

  return (
    <div className="app-shell">
      <Header
        search={search}
        onSearchChange={setSearch}
        category={category}
        onCategoryChange={setCategory}
      />

      <main className="app-main">
        <aside className="app-sidebar">
          {state.status === "loading" && <LoadingState />}
          {state.status === "error" && <ErrorState message={state.message} onRetry={reload} />}
          {state.status !== "loading" && state.status !== "error" && (
            <QuestionList
              questions={filteredQuestions}
              activeId={activeQuestion?.id ?? null}
              onSelect={setActiveId}
              answeredIds={new Set(answers.keys())}
            />
          )}
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
              onAnswered={handleAnswered}
              previousSelection={answers.get(activeQuestion.id)}
            />
          )}
        </section>
      </main>
    </div>
  );
}

export default App;

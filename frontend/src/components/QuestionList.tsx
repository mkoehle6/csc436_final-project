import type { TriviaQuestion } from "../types/trivia";

interface QuestionListProps {
  questions: TriviaQuestion[];
  activeId: number | null;
  onSelect: (id: number) => void;
  answeredIds: Set<number>;
}

/** Left-hand sidebar listing every question in the round, mirroring the mockup. */
export function QuestionList({ questions, activeId, onSelect, answeredIds }: QuestionListProps) {
  if (questions.length === 0) {
    return <p className="question-list__empty">No questions match your search.</p>;
  }

  return (
    <ol className="question-list" aria-label="Trivia questions">
      {questions.map((q, index) => (
        <li key={q.id}>
          <button
            type="button"
            className={
              "question-list__item" +
              (q.id === activeId ? " question-list__item--active" : "") +
              (answeredIds.has(q.id) ? " question-list__item--answered" : "")
            }
            onClick={() => onSelect(q.id)}
            aria-current={q.id === activeId ? "true" : undefined}
          >
            <span className="question-list__label">Question {index + 1}</span>
            <span className="question-list__prompt">{q.prompt}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

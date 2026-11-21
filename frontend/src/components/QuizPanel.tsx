import { useState } from "react";
import type { AnswerState } from "../hooks/useGame";
import type { TriviaQuestion } from "../types/trivia";

interface QuizPanelProps {
  question: TriviaQuestion;
  answer: AnswerState | undefined;
  onAnswer: (choice: string) => void;
}

/**
 * Main quiz card: prompt, image and four choices. The browser does not know the
 * correct answer; it shows the server's verdict once it arrives, a "Checking…"
 * state while waiting, and an error with Retry if the call fails (F2).
 */
export function QuizPanel({ question, answer, onAnswer }: QuizPanelProps) {
  const [imageFailed, setImageFailed] = useState(false);

  const result = answer?.status === "done" ? answer.result : null;
  const selected = answer?.status === "done" ? answer.result.selectedAnswer : answer?.selected;
  const locked = answer?.status === "pending" || answer?.status === "done";

  return (
    <section className="quiz-panel" aria-labelledby="quiz-prompt">
      <h2 id="quiz-prompt" className="quiz-panel__prompt">
        {question.prompt}
      </h2>

      {question.imagePath && !imageFailed ? (
        <img className="quiz-panel__image" src={question.imagePath} alt="" onError={() => setImageFailed(true)} />
      ) : (
        <div className="quiz-panel__image quiz-panel__image--placeholder" aria-hidden="true">
          Image unavailable
        </div>
      )}

      <div className="quiz-panel__choices">
        {question.choices.map((choice) => {
          const isSelected = selected === choice;
          const isCorrectChoice = result?.correctAnswer === choice;
          const className = [
            "choice-button",
            isSelected && answer?.status === "pending" ? "choice-button--pending" : "",
            isCorrectChoice ? "choice-button--correct" : "",
            result && isSelected && !isCorrectChoice ? "choice-button--incorrect" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              key={choice}
              type="button"
              className={className}
              onClick={() => onAnswer(choice)}
              disabled={locked}
              aria-pressed={isSelected}
            >
              <span>{choice}</span>
              {isCorrectChoice && (
                <span className="choice-button__icon" aria-label="Correct answer">
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="quiz-panel__feedback" aria-live="polite">
        {answer?.status === "pending" && <p role="status">Checking your answer…</p>}
        {result && (
          <p className={result.isCorrect ? "feedback feedback--correct" : "feedback feedback--incorrect"}>
            {result.isCorrect ? "Correct!" : `Not quite. The answer is ${result.correctAnswer}.`}
          </p>
        )}
        {answer?.status === "error" && (
          <div className="status-panel status-panel--error" role="alert">
            <p>Couldn&apos;t submit your answer.</p>
            <p className="status-panel__detail">{answer.message}</p>
            <button type="button" className="btn-secondary" onClick={() => onAnswer(answer.selected)}>
              Retry
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

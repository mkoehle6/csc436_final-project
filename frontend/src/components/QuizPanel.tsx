import { useState } from "react";
import type { TriviaQuestion } from "../types/trivia";

interface QuizPanelProps {
  question: TriviaQuestion;
  onAnswered: (questionId: number, selected: string, isCorrect: boolean) => void;
  previousSelection: string | undefined;
}

/** Main quiz card: prompt, image, and four answer choices (matches the mockup). */
export function QuizPanel({ question, onAnswered, previousSelection }: QuizPanelProps) {
  const [selected, setSelected] = useState<string | undefined>(previousSelection);
  const [imageFailed, setImageFailed] = useState(false);

  const handleSelect = (choice: string) => {
    if (selected) return; // lock in the first answer, like a real quiz
    setSelected(choice);
    onAnswered(question.id, choice, choice === question.correctAnswer);
  };

  return (
    <section className="quiz-panel" aria-labelledby="quiz-prompt">
      <h2 id="quiz-prompt" className="quiz-panel__prompt">
        {question.prompt}
      </h2>

      {question.imagePath && !imageFailed ? (
        <img
          className="quiz-panel__image"
          src={question.imagePath}
          alt=""
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="quiz-panel__image quiz-panel__image--placeholder" aria-hidden="true">
          Image unavailable
        </div>
      )}

      <div className="quiz-panel__choices">
        {question.choices.map((choice) => {
          const isSelected = selected === choice;
          const isCorrectChoice = choice === question.correctAnswer;
          const showFeedback = Boolean(selected);
          const className = [
            "choice-button",
            showFeedback && isCorrectChoice ? "choice-button--correct" : "",
            showFeedback && isSelected && !isCorrectChoice ? "choice-button--incorrect" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              key={choice}
              type="button"
              className={className}
              onClick={() => handleSelect(choice)}
              disabled={showFeedback}
              aria-pressed={isSelected}
            >
              <span>{choice}</span>
              {showFeedback && isCorrectChoice && (
                <span className="choice-button__icon" aria-label="Correct answer">
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

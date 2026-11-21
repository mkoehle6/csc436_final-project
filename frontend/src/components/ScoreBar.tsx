import type { ScoreResult } from "../types/trivia";

interface ScoreBarProps {
  signedIn: boolean;
  /** Server-side session score (signed in), or null before the first answer. */
  score: ScoreResult | null;
  /** Answers checked this round (used for the signed-out tally). */
  answered: number;
  correct: number;
  degraded: boolean;
  onNewRound: () => void;
}

/** Round summary above the question list, plus the New round action. */
export function ScoreBar({ signedIn, score, answered, correct, degraded, onNewRound }: ScoreBarProps) {
  return (
    <div className="score-bar">
      <div className="score-bar__row">
        <p className="score-bar__score" aria-live="polite">
          {signedIn && score
            ? `${score.points} pts · ${score.correctCount}/${score.totalCount} correct`
            : `${correct}/${answered} correct`}
        </p>
        <button type="button" className="btn-secondary" onClick={onNewRound}>
          New round
        </button>
      </div>
      <p className="score-bar__note">{signedIn ? "Your score is saved." : "Sign in to save your score."}</p>
      {degraded && (
        <p className="score-bar__notice" role="status">
          The Simpsons API is unavailable, so you&apos;re playing saved questions.
        </p>
      )}
    </div>
  );
}

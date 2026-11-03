/**
 * Core calculation (Q1): scoring for a trivia game session.
 * Kept pure and dependency-free so it is trivially unit-testable and so its
 * expected output can be hand-predicted before running tests.
 */
export interface AnswerRecord {
  isCorrect: boolean;
}

export interface ScoreResult {
  correctCount: number;
  totalCount: number;
  percentage: number;
  points: number;
}

/** Each correct answer is worth 10 points flat; percentage is rounded to 1 decimal place. */
export function computeScore(answerRecords: AnswerRecord[]): ScoreResult {
  const totalCount = answerRecords.length;
  const correctCount = answerRecords.filter((a) => a.isCorrect).length;
  const percentage = totalCount === 0 ? 0 : Math.round((correctCount / totalCount) * 1000) / 10;
  const points = correctCount * 10;
  return { correctCount, totalCount, percentage, points };
}

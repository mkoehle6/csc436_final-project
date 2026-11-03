import { describe, expect, it } from "vitest";
import { computeScore } from "../src/lib/scoring.js";

describe("computeScore (Q1 core calculation)", () => {
  it("returns zeroed result for no answers", () => {
    // Hand-predicted: 0 correct / 0 total -> 0%, 0 points.
    expect(computeScore([])).toEqual({
      correctCount: 0,
      totalCount: 0,
      percentage: 0,
      points: 0,
    });
  });

  it("computes partial score correctly", () => {
    // Hand-predicted: 3 correct out of 4 -> 75%, 30 points.
    const result = computeScore([
      { isCorrect: true },
      { isCorrect: true },
      { isCorrect: true },
      { isCorrect: false },
    ]);
    expect(result).toEqual({ correctCount: 3, totalCount: 4, percentage: 75, points: 30 });
  });

  it("rounds percentage to one decimal place", () => {
    // Hand-predicted: 1 correct out of 3 -> 33.333...% rounds to 33.3%, 10 points.
    const result = computeScore([{ isCorrect: true }, { isCorrect: false }, { isCorrect: false }]);
    expect(result).toEqual({ correctCount: 1, totalCount: 3, percentage: 33.3, points: 10 });
  });

  it("gives a perfect score for all-correct answers", () => {
    // Hand-predicted: 2 correct out of 2 -> 100%, 20 points.
    const result = computeScore([{ isCorrect: true }, { isCorrect: true }]);
    expect(result).toEqual({ correctCount: 2, totalCount: 2, percentage: 100, points: 20 });
  });
});

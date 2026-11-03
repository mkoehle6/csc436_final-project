import { simpsonsApi, type SimpsonsCharacter } from "../integrations/simpsonsApi.js";
import { ApiErrors } from "./errors.js";

export interface GeneratedQuestion {
  prompt: string;
  category: "character";
  correctAnswer: string;
  choices: string[];
  imagePath: string;
  sourceEntityId: number;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

function buildOccupationQuestion(
  subject: SimpsonsCharacter,
  pool: SimpsonsCharacter[],
): GeneratedQuestion | null {
  if (!subject.occupation) return null;
  const distractors = pool
    .filter((c) => c.id !== subject.id && c.occupation && c.occupation !== subject.occupation)
    .map((c) => c.occupation as string);
  const uniqueDistractors = shuffle([...new Set(distractors)]).slice(0, 3);
  if (uniqueDistractors.length < 3) return null;

  return {
    prompt: `What is ${subject.name}'s occupation?`,
    category: "character",
    correctAnswer: subject.occupation,
    choices: shuffle([subject.occupation, ...uniqueDistractors]),
    imagePath: simpsonsApi.imageUrl("character", subject.id),
    sourceEntityId: subject.id,
  };
}

/**
 * Generates `count` multiple-choice character-occupation questions by pulling a
 * page of characters from The Simpsons API. Falls back gracefully (throws a
 * typed ApiError) rather than ever returning a malformed question.
 */
export async function generateCharacterQuestions(count: number): Promise<GeneratedQuestion[]> {
  const page = Math.floor(Math.random() * 60) + 1; // API reports 60 pages of characters
  const { results } = await simpsonsApi.getCharactersPage(page);
  const candidates = shuffle(results);

  const questions: GeneratedQuestion[] = [];
  for (const candidate of candidates) {
    if (questions.length >= count) break;
    const q = buildOccupationQuestion(candidate, results);
    if (q) questions.push(q);
  }

  if (questions.length === 0) {
    throw ApiErrors.upstreamUnavailable("Could not generate trivia questions from Simpsons API");
  }
  return questions;
}

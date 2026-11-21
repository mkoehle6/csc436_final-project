import { simpsonsApi, type SimpsonsCharacter } from "../integrations/simpsonsApi.js";
import { cleanName, cleanOccupation, isNamedCharacter } from "./characterFilters.js";
import { ApiErrors } from "./errors.js";

export interface GeneratedQuestion {
  prompt: string;
  category: "character";
  correctAnswer: string;
  choices: string[];
  imagePath: string;
  sourceEntityId: number;
}

/** Characters The Simpsons API reports across its pages (60 pages of 20). */
const CHARACTER_PAGES = 60;

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

interface QuizCharacter {
  id: number;
  name: string;
  occupation: string;
}

/** Keeps only named characters with a usable occupation, cleaned for display. */
export function toQuizCharacters(characters: SimpsonsCharacter[]): QuizCharacter[] {
  const result: QuizCharacter[] = [];
  for (const c of characters) {
    const occupation = cleanOccupation(c.occupation);
    if (!occupation || !isNamedCharacter(c.name)) continue;
    result.push({ id: c.id, name: cleanName(c.name), occupation });
  }
  return result;
}

function buildOccupationQuestion(subject: QuizCharacter, pool: QuizCharacter[]): GeneratedQuestion | null {
  const distractors = [
    ...new Set(pool.filter((c) => c.occupation !== subject.occupation).map((c) => c.occupation)),
  ];
  const picked = shuffle(distractors).slice(0, 3);
  if (picked.length < 3) return null;

  return {
    prompt: `What is ${subject.name}'s occupation?`,
    category: "character",
    correctAnswer: subject.occupation,
    choices: shuffle([subject.occupation, ...picked]),
    imagePath: simpsonsApi.imageUrl("character", subject.id),
    sourceEntityId: subject.id,
  };
}

/**
 * Generates up to `count` character-occupation questions from one random page
 * of The Simpsons API. Throws a typed upstream error (rather than returning
 * malformed questions) when the API is down or the page has nothing usable.
 */
export async function generateCharacterQuestions(count: number): Promise<GeneratedQuestion[]> {
  const page = Math.floor(Math.random() * CHARACTER_PAGES) + 1;
  const { results } = await simpsonsApi.getCharactersPage(page);
  const pool = toQuizCharacters(results);

  const questions: GeneratedQuestion[] = [];
  for (const subject of shuffle(pool)) {
    if (questions.length >= count) break;
    const q = buildOccupationQuestion(subject, pool);
    if (q) questions.push(q);
  }

  if (questions.length === 0) {
    throw ApiErrors.upstreamUnavailable("Could not generate trivia questions from Simpsons API");
  }
  return questions;
}

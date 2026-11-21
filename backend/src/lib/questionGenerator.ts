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

/**
 * The Simpsons API lists 1,182 characters on 60 pages: pages 1–59 hold 20 each,
 * page 60 holds only 2, and up to a third of a page can have an "Unknown"
 * occupation. A single page can therefore be too thin to build questions from
 * (a question needs a subject plus three distinct wrong answers), so a top-up
 * pools characters from several random pages.
 */
const CHARACTER_PAGES = 60;
/** Upper bound on provider calls per top-up (respects the API's informal limits). */
export const MAX_PAGES_PER_TOP_UP = 3;

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

/** `n` distinct random page numbers in 1..CHARACTER_PAGES. */
function randomPages(n: number): number[] {
  return shuffle(Array.from({ length: CHARACTER_PAGES }, (_, i) => i + 1)).slice(0, n);
}

/**
 * Generates up to `count` character-occupation questions from characters
 * pooled across up to MAX_PAGES_PER_TOP_UP random pages of The Simpsons API.
 * Fetching stops early once the pool is big enough. A failing page is skipped;
 * only if every page fails is the provider reported unavailable. Never returns
 * malformed questions: an unusable pool is a typed error too.
 */
export async function generateCharacterQuestions(count: number): Promise<GeneratedQuestion[]> {
  const pool: QuizCharacter[] = [];
  const seen = new Set<number>();
  let fetched = 0;
  let lastError: unknown;

  for (const page of randomPages(MAX_PAGES_PER_TOP_UP)) {
    if (pool.length >= count + 3) break; // enough subjects plus wrong answers
    try {
      const { results } = await simpsonsApi.getCharactersPage(page);
      fetched += 1;
      for (const c of toQuizCharacters(results)) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          pool.push(c);
        }
      }
    } catch (err) {
      lastError = err; // try the next page
    }
  }

  if (fetched === 0) {
    throw lastError instanceof Error ? lastError : ApiErrors.upstreamUnavailable();
  }

  const questions: GeneratedQuestion[] = [];
  for (const subject of shuffle(pool)) {
    if (questions.length >= count) break;
    const q = buildOccupationQuestion(subject, pool);
    if (q) questions.push(q);
  }

  if (questions.length === 0) {
    throw ApiErrors.upstreamUnavailable("The Simpsons API returned too few usable characters to build questions");
  }
  return questions;
}

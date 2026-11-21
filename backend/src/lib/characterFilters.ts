/**
 * Cleans The Simpsons API character data into something fit for a quiz.
 *
 * The API includes background extras ("Female Unnamed with brown hair…"),
 * descriptions instead of names ("Buck-toothed girl"), "Unknown" occupations,
 * episode notes in parentheses ("Becky (It's a Mad, Mad, Mad, Mad Marge)") and
 * occupations with several roles glued together. Pure functions, so the rules
 * can be unit-tested with hand-predicted cases.
 */

/** Words allowed in lowercase inside a real name ("Krusty the Clown", "Abe of Springfield"). */
const NAME_CONNECTORS = new Set(["the", "of", "and", "de", "del", "la", "le", "van", "von", "da", "di", "y"]);

const MAX_OCCUPATION_LENGTH = 60;

/** Drops a trailing parenthetical note: "James L. Brooks (character)" → "James L. Brooks". */
export function cleanName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();
}

/**
 * True for proper names, false for extras and descriptions. A real name has
 * every word capitalized except known connectors, and never says "Unnamed".
 */
export function isNamedCharacter(rawName: string): boolean {
  const name = cleanName(rawName);
  if (!name || /\b(unnamed|unknown)\b/i.test(name)) return false;
  return name.split(" ").every((word) => NAME_CONNECTORS.has(word) || /^[^a-z]/.test(word));
}

/**
 * First listed role, without "(formerly)"-style notes, or null if unusable.
 *   "Student at Springfield Elementary SchoolStudent at a religious…" → "Student at Springfield Elementary School"
 *   "Student at X, CTU Agent, Hall-monitor" → "Student at X"
 */
export function cleanOccupation(occupation: string | null | undefined): string | null {
  if (!occupation) return null;
  const firstRole = occupation
    .split(/(?<=[a-z])(?=[A-Z])/)[0]! // roles concatenated without a separator
    .split(/[,;/]|\s+\band\b\s+(?=[A-Z])/)[0]!
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!firstRole || /^(unknown|n\/a|none)$/i.test(firstRole)) return null;
  if (firstRole.length > MAX_OCCUPATION_LENGTH) return null;
  return firstRole;
}

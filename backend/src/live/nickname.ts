/**
 * Public, synthetic display names for the leaderboard.
 *
 * The leaderboard is public, but users are real Google accounts. Showing their
 * names or emails would put real personal data on a public page (a hard gate),
 * so each player is shown under a made-up nickname derived from their internal
 * id: stable for the same player, unique (the number is the id), and revealing
 * nothing about the person.
 */

const ADJECTIVES = [
  "Cosmic", "Sleepy", "Dizzy", "Mighty", "Lucky", "Sneaky",
  "Jolly", "Grumpy", "Speedy", "Clever", "Brave", "Radiant",
] as const;

const NOUNS = [
  "Llama", "Donut", "Monorail", "Squirrel", "Saxophone", "Pretzel",
  "Bowler", "Walrus", "Comet", "Cactus", "Robot", "Pelican",
] as const;

export function nicknameFor(userId: number): string {
  // Spread consecutive ids across the word lists (multiplicative hash).
  const h = Math.imul(userId, 2654435761) >>> 0;
  const adjective = ADJECTIVES[h % ADJECTIVES.length]!;
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]!;
  return `${adjective} ${noun} #${userId}`;
}

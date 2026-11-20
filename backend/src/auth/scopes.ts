/**
 * Roles (F9) and the OAuth scopes each role is granted (F8, F12).
 *
 * The role lives in the `users` table; the scopes are derived from it when an
 * access token is issued. Routes check both: the role answers "who is this?",
 * the scope answers "what was this token issued to do?" — which matters once
 * MCP clients can request narrower tokens than the user's full role allows.
 */

export const ROLES = ["viewer", "operator"] as const;
export type Role = (typeof ROLES)[number];

export const SCOPES = {
  /** Read questions, leaderboards and one's own sessions. */
  read: "trivia:read",
  /** Start game sessions and submit answers. */
  play: "trivia:play",
  /** Create and delete questions in the question bank. */
  writeQuestions: "questions:write",
} as const;

const ROLE_SCOPES: Record<Role, string[]> = {
  viewer: [SCOPES.read, SCOPES.play],
  operator: [SCOPES.read, SCOPES.play, SCOPES.writeQuestions],
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function scopesForRole(role: Role): string[] {
  return [...ROLE_SCOPES[role]];
}

/** `scope` is the space-separated OAuth scope string from a validated token. */
export function hasScope(scope: string | undefined, required: string): boolean {
  return (scope ?? "").split(" ").filter(Boolean).includes(required);
}

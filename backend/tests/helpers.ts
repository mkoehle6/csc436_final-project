import { exportJWK, generateKeyPair } from "jose";
import { vi } from "vitest";

export const TEST_ISSUER = "http://localhost:3001";
export const TEST_AUDIENCE = "trivianerd-api";
export const TEST_KID = "test-signing-key";

/** Generates a throwaway ES256 signing key and points the auth config at it. */
export async function useTestSigningKey() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: TEST_KID };
  process.env.AUTH_PRIVATE_JWK = JSON.stringify(jwk);
  process.env.AUTH_ISSUER = TEST_ISSUER;
  process.env.AUTH_AUDIENCE = TEST_AUDIENCE;
  return privateKey;
}

/**
 * Fresh module graph + fresh in-memory PostgreSQL (PGlite) with all migrations
 * applied. Call `close()` when done so the embedded database is released.
 */
export async function freshAppWithDb() {
  process.env.DATABASE_URL = ":memory:";
  vi.resetModules();
  const { db, runMigrations, closeDb } = await import("../src/db/client.js");
  await runMigrations();
  const { createApp } = await import("../src/app.js");
  return { app: createApp(), db, close: closeDb };
}

/** Pulls `name=value` out of a supertest response's Set-Cookie headers. */
export function getCookie(setCookie: string[] | string | undefined, name: string): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of all) {
    const [pair] = header.split(";");
    const [key, ...rest] = (pair ?? "").split("=");
    if (key?.trim() === name) return rest.join("=");
  }
  return undefined;
}

import { z } from "zod";
import { ApiError, ApiErrors } from "../lib/errors.js";

/**
 * Server-side integration with The Simpsons API (https://thesimpsonsapi.com) — F10.
 *
 * Guarantees provided here:
 *  - timeout per request (no key/secret needed; this API is public, but we still
 *    isolate the base URL so a key could be injected from a secret store later)
 *  - bounded retry (max 2 retries, exponential backoff) for transient failures only
 *  - in-memory TTL cache so we do not exceed the provider's informal rate limits
 *  - runtime response validation with zod (never trust the shape of a 3rd-party response)
 *  - graceful degradation: callers get a typed error and can fall back to cached
 *    questions already stored in our own database when the provider is down
 */

const BASE_URL = process.env.SIMPSONS_API_BASE_URL ?? "https://thesimpsonsapi.com/api";
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes, respects "pages don't change" nature of this API

const characterSchema = z.object({
  id: z.number(),
  name: z.string(),
  age: z.number().nullable().optional(),
  occupation: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  portrait_path: z.string(),
  phrases: z.array(z.string()).optional().default([]),
});

const episodeSchema = z.object({
  id: z.number(),
  name: z.string(),
  season: z.number(),
  episode_number: z.number(),
  airdate: z.string(),
  image_path: z.string(),
  synopsis: z.string().optional(),
});

const locationSchema = z.object({
  id: z.number(),
  name: z.string(),
  town: z.string().nullable().optional(),
  use: z.string().nullable().optional(),
  image_path: z.string(),
});

const pagedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    count: z.number(),
    next: z.string().nullable(),
    prev: z.string().nullable(),
    pages: z.number(),
    results: z.array(item),
  });

export type SimpsonsCharacter = z.infer<typeof characterSchema>;
export type SimpsonsEpisode = z.infer<typeof episodeSchema>;
export type SimpsonsLocation = z.infer<typeof locationSchema>;

type CacheEntry = { expiresAt: number; value: unknown };
const cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function setCached(key: string, value: unknown): void {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        const upstreamError = ApiErrors.upstreamUnavailable(
          `Simpsons API returned ${res.status} for ${url}`,
        );
        if (res.status < 500) {
          // Non-retryable client error (e.g. 404) — surface immediately.
          throw upstreamError;
        }
        // 5xx is treated as transient; fall through to the retry logic below.
        lastError = upstreamError;
        throw upstreamError;
      }
      return await res.json();
    } catch (err) {
      if (err instanceof ApiError && err.statusCode < 500) {
        throw err; // non-retryable, bail out of the loop immediately
      }
      lastError =
        err instanceof Error && err.name === "AbortError"
          ? ApiErrors.upstreamUnavailable("Simpsons API request timed out")
          : err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 200));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : ApiErrors.upstreamUnavailable();
}

async function getPaged<T>(
  resource: "characters" | "episodes" | "locations",
  page: number,
  itemSchema: z.ZodTypeAny,
): Promise<{ results: T[]; count: number; pages: number }> {
  const cacheKey = `${resource}:page:${page}`;
  const cached = getCached<{ results: T[]; count: number; pages: number }>(cacheKey);
  if (cached) return cached;

  const url = `${BASE_URL}/${resource}?page=${page}`;
  const raw = await fetchJsonWithRetry(url);
  const parsed = pagedSchema(itemSchema).safeParse(raw);
  if (!parsed.success) {
    throw ApiErrors.upstreamUnavailable("Simpsons API returned an unexpected response shape");
  }
  const value = {
    results: parsed.data.results as T[],
    count: parsed.data.count,
    pages: parsed.data.pages,
  };
  setCached(cacheKey, value);
  return value;
}

export const simpsonsApi = {
  getCharactersPage: (page: number) =>
    getPaged<SimpsonsCharacter>("characters", page, characterSchema),
  getEpisodesPage: (page: number) => getPaged<SimpsonsEpisode>("episodes", page, episodeSchema),
  getLocationsPage: (page: number) =>
    getPaged<SimpsonsLocation>("locations", page, locationSchema),
  imageUrl: (kind: "character" | "episode" | "location", id: number, size: 200 | 500 = 500) =>
    `https://cdn.thesimpsonsapi.com/${size}/${kind}/${id}.webp`,
};

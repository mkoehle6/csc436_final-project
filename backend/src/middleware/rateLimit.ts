import type { NextFunction, Request, Response } from "express";
import { ApiErrors } from "../lib/errors.js";

/**
 * In-memory fixed-window rate limiter (S1).
 *
 * State lives in this process, which is correct for TriviaNerd's single
 * instance per environment (render.yaml numInstances: 1). Scaling out would
 * need a shared store (e.g. Redis) so instances agree on counts.
 *
 * Every response carries the IETF draft RateLimit headers, so clients (and
 * evidence) can see the policy, what is left and when the window resets; a
 * refused request gets 429, Retry-After and the standard JSON error shape.
 */

export interface RateLimitOptions {
  /** Label used in the 429 message and logs, e.g. "writes". */
  name: string;
  windowMs: number;
  max: number;
  /** Who is being limited. Defaults to the client IP (see TRUST_PROXY in app.ts). */
  key?: (req: Request) => string;
}

/** Sweep expired windows once the map holds this many keys, so memory stays bounded. */
const SWEEP_THRESHOLD = 1000;

export const byIp = (req: Request) => `ip:${req.ip ?? "unknown"}`;

/** The signed-in user (validated token subject) when there is one, otherwise the IP. */
export const byUserOrIp = (req: Request) => (req.user?.sub ? `user:${req.user.sub}` : byIp(req));

export function rateLimit({ name, windowMs, max, key = byIp }: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  function sweep(now: number) {
    for (const [k, entry] of hits) if (entry.resetAt <= now) hits.delete(k);
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (hits.size >= SWEEP_THRESHOLD) sweep(now);

    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }

    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader("RateLimit-Policy", `${max};w=${Math.round(windowMs / 1000)}`);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (entry.count >= max) {
      res.setHeader("RateLimit-Remaining", "0");
      res.setHeader("Retry-After", String(resetSeconds));
      next(ApiErrors.tooManyRequests(`Too many ${name} requests; try again in ${resetSeconds} s`));
      return;
    }

    entry.count += 1;
    res.setHeader("RateLimit-Remaining", String(max - entry.count));
    next();
  };
}

/** Per-endpoint-class limits (S1). Each call creates independent counters. */
export const limits = {
  /** Google login redirect and callback: brute-force/abuse target. */
  login: () => rateLimit({ name: "login", windowMs: 60_000, max: 20 }),
  /** Session cookie → access token, and logout. Called on page load and every ~14 min. */
  token: () => rateLimit({ name: "token", windowMs: 60_000, max: 60 }),
  /** State-changing API calls, counted per signed-in user (IP when anonymous). */
  writes: () => rateLimit({ name: "write", windowMs: 60_000, max: 30, key: byUserOrIp }),
  /** Endpoints that can trigger calls to The Simpsons API. */
  thirdParty: () => rateLimit({ name: "question", windowMs: 60_000, max: 30 }),
  /** Backstop for everything under /api. */
  api: () => rateLimit({ name: "API", windowMs: 60_000, max: 120 }),
};

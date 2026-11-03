import type { NextFunction, Request, Response } from "express";
import { ApiErrors } from "../lib/errors.js";

/**
 * Minimal in-memory fixed-window rate limiter (S1). Suitable for a single
 * instance / dev-staging; swap for a shared store (Redis) behind multiple
 * instances in production.
 */
export function rateLimit(options: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (entry.count >= options.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000).toString());
      next(ApiErrors.tooManyRequests());
      return;
    }

    entry.count += 1;
    next();
  };
}

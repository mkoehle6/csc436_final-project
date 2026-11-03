import express, { type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import { ApiError } from "./lib/errors.js";
import { healthRouter } from "./routes/health.js";
import { questionsRouter } from "./routes/questions.js";
import { sessionsRouter } from "./routes/sessions.js";
import { rateLimit } from "./middleware/rateLimit.js";

/** D7: exact-origin CORS allowlist — never "*" with credentials. */
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function createApp() {
  const app = express();

  app.use(pinoHttp());
  app.use(express.json());

  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    }
    if (req.method === "OPTIONS") {
      res.status(origin && ALLOWED_ORIGINS.includes(origin) ? 204 : 403).end();
      return;
    }
    next();
  });

  // D7: baseline security headers.
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https://cdn.thesimpsonsapi.com data:; connect-src 'self'",
    );
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.use(healthRouter);
  app.use(
    "/api",
    rateLimit({ windowMs: 60_000, max: 120 }),
    questionsRouter,
    sessionsRouter,
  );

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  // Centralized error handler ensures one consistent JSON error shape (F3).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.statusCode).json(err.toJSON());
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  return app;
}

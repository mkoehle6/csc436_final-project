import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import { ApiError, ApiErrors } from "./lib/errors.js";
import { isAllowedOrigin } from "./lib/origins.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { questionsRouter } from "./routes/questions.js";
import { sessionsRouter } from "./routes/sessions.js";
import { rateLimit } from "./middleware/rateLimit.js";

export function createApp() {
  const app = express();

  // Behind Render's load balancer (and later a CDN) the TCP peer is the proxy, not
  // the visitor. TRUST_PROXY = number of proxy hops in front of the app, so req.ip
  // (used by the rate limiter, S1) is the real client address and cannot be spoofed
  // with an X-Forwarded-For header. Unset locally, where there is no proxy.
  const proxyHops = Number(process.env.TRUST_PROXY ?? 0);
  if (proxyHops > 0) app.set("trust proxy", proxyHops);

  app.use(
    pinoHttp({
      // Never log credentials: bearer tokens or session/login cookies.
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    }),
  );
  app.use(express.json());
  app.use(cookieParser());

  // D7: exact-origin CORS allowlist (lib/origins.ts) — never "*" with credentials.
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    }
    if (req.method === "OPTIONS") {
      res.status(isAllowedOrigin(origin) ? 204 : 403).end();
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
  app.use(authRouter);
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
    // express.json() rejects malformed bodies with a 400-status SyntaxError; keep it a 400 (F3).
    if (err instanceof SyntaxError && "status" in err && err.status === 400) {
      res.status(400).json(ApiErrors.badRequest("Request body is not valid JSON").toJSON());
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  return app;
}

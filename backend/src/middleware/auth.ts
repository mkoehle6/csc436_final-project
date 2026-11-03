import type { NextFunction, Request, Response } from "express";
import { ApiErrors } from "../lib/errors.js";
import { verifyAccessToken, type AppClaims } from "../auth/jwt.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: AppClaims;
  }
}

/** Requires a valid bearer token; rejects anonymous callers with 401 (F9). */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    next(ApiErrors.unauthorized());
    return;
  }
  try {
    req.user = await verifyAccessToken(token);
    next();
  } catch {
    next(ApiErrors.unauthorized("Invalid or expired token"));
  }
}

/** Requires one of the given roles, taken only from validated claims; rejects with 403 (F9). */
export function requireRole(...roles: Array<"viewer" | "operator">) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      next(ApiErrors.forbidden());
      return;
    }
    next();
  };
}

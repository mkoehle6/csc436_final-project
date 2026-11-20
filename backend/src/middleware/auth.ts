import type { NextFunction, Request, Response } from "express";
import { ApiErrors } from "../lib/errors.js";
import { verifyAccessToken, type AppClaims } from "../auth/jwt.js";
import { hasScope, type Role } from "../auth/scopes.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: AppClaims;
  }
}

/** Requires a valid bearer token; rejects anonymous or invalid callers with 401 (F8, F9). */
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
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      next(ApiErrors.forbidden());
      return;
    }
    next();
  };
}

/** Requires the token to carry an OAuth scope; rejects with 403 (F8 scope check, F12). */
export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!hasScope(req.user?.scope, scope)) {
      next(ApiErrors.forbidden(`Token is missing the ${scope} scope`));
      return;
    }
    next();
  };
}

/** The acting user's id, from the validated token's `sub` (our users.id). */
export function actorUserId(req: Request): number {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiErrors.unauthorized("Token subject is not a valid user id");
  }
  return id;
}

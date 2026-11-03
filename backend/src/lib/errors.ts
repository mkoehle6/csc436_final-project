/**
 * Single JSON error shape used by every API route (F3):
 * { "error": { "code": "VALIDATION_ERROR", "message": "...", "details"?: unknown } }
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const ApiErrors = {
  badRequest: (message: string, details?: unknown) =>
    new ApiError(400, "VALIDATION_ERROR", message, details),
  unauthorized: (message = "Authentication required") =>
    new ApiError(401, "UNAUTHORIZED", message),
  forbidden: (message = "Insufficient permissions") =>
    new ApiError(403, "FORBIDDEN", message),
  notFound: (message = "Resource not found") => new ApiError(404, "NOT_FOUND", message),
  conflict: (message: string) => new ApiError(409, "CONFLICT", message),
  upstreamUnavailable: (message = "Upstream service unavailable") =>
    new ApiError(502, "UPSTREAM_UNAVAILABLE", message),
  tooManyRequests: (message = "Rate limit exceeded") =>
    new ApiError(429, "RATE_LIMITED", message),
  internal: (message = "Internal server error") => new ApiError(500, "INTERNAL_ERROR", message),
};

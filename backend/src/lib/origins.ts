/** D7: exact-origin allowlist shared by CORS and the cookie-endpoint CSRF check. Never "*". */
export function allowedOrigins(): string[] {
  return (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | undefined): origin is string {
  return origin !== undefined && allowedOrigins().includes(origin);
}

/**
 * Auth configuration, read lazily from the environment so tests can set
 * variables before first use and missing secrets fail at the point of use
 * with a clear message rather than crashing unrelated routes.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export const authConfig = {
  /** `iss` of the access tokens this backend issues and accepts. */
  get issuer() {
    return process.env.AUTH_ISSUER ?? "http://localhost:3001";
  },
  /** `aud` of the access tokens: the TriviaNerd API (and later the MCP server). */
  get audience() {
    return process.env.AUTH_AUDIENCE ?? "trivianerd-api";
  },
  /** Where the browser is sent after login/logout. */
  get appBaseUrl() {
    return process.env.APP_BASE_URL ?? "http://localhost:5173";
  },
  /**
   * F9: emails promoted to operator when they sign in (verified Google email).
   * Set in the hosting platform's environment, never in the repo. Only promotes:
   * removing an email does not demote; that stays a deliberate admin action.
   */
  get bootstrapOperatorEmails(): string[] {
    return (process.env.BOOTSTRAP_OPERATOR_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  /** Cookies get `Secure` whenever the backend itself is served over HTTPS. */
  get secureCookies() {
    return this.issuer.startsWith("https://");
  },
  accessTokenTtlSeconds: 15 * 60,
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  loginStateTtlMs: 10 * 60 * 1000,

  /**
   * MCP (F12): the canonical resource URI of the MCP server (RFC 8707). Tokens for
   * MCP clients carry it as `aud`, so they can never be used on the web API, and
   * web-app tokens (aud "trivianerd-api") are never accepted by /mcp.
   */
  get mcpResource() {
    return process.env.MCP_RESOURCE_URL ?? `${this.issuer}/mcp`;
  },
  mcp: {
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    authorizationCodeTtlMs: 10 * 60 * 1000,
    /** Lifetime of the signed consent request carried by the consent form. */
    consentRequestTtlSeconds: 10 * 60,
  },

  google: {
    get clientId() {
      return required("GOOGLE_CLIENT_ID");
    },
    get clientSecret() {
      return required("GOOGLE_CLIENT_SECRET");
    },
    get redirectUri() {
      return process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3001/auth/callback";
    },
    // Endpoints are overridable only so tests can point them at a local stub.
    get authorizationEndpoint() {
      return process.env.GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
    },
    get tokenEndpoint() {
      return process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
    },
    get jwksUri() {
      return process.env.GOOGLE_JWKS_URI ?? "https://www.googleapis.com/oauth2/v3/certs";
    },
    issuers: ["https://accounts.google.com", "accounts.google.com"],
  },
};

export const SESSION_COOKIE = "tn_session";
export const LOGIN_STATE_COOKIE = "tn_oauth_state";

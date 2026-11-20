import { createLocalJWKSet, importJWK, type JSONWebKeySet, type JWK } from "jose";

/**
 * The backend's own token-signing key (ES256 / P-256).
 *
 * The private key comes from AUTH_PRIVATE_JWK — in production that variable is
 * injected from the hosting platform's secret store; locally it lives in the
 * git-ignored backend/.env (create it with `npm run auth:keygen`). Only the
 * public half is ever published, at /.well-known/jwks.json.
 */

type PrivateKey = Awaited<ReturnType<typeof importJWK>>;

export interface SigningKey {
  kid: string;
  privateKey: PrivateKey;
  publicJwks: JSONWebKeySet;
  verificationKeys: ReturnType<typeof createLocalJWKSet>;
}

let cached: { raw: string; key: SigningKey } | undefined;

export async function getSigningKey(): Promise<SigningKey> {
  const raw = process.env.AUTH_PRIVATE_JWK;
  if (!raw) {
    throw new Error("AUTH_PRIVATE_JWK is not configured (run `npm run auth:keygen`)");
  }
  if (cached?.raw === raw) return cached.key;

  const jwk = JSON.parse(raw) as JWK;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y || !jwk.kid) {
    throw new Error("AUTH_PRIVATE_JWK must be an EC P-256 private JWK with a kid");
  }

  // Build the public JWK field by field so the private `d` can never leak into it.
  const publicJwk: JWK = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    kid: jwk.kid,
    alg: "ES256",
    use: "sig",
  };
  const publicJwks: JSONWebKeySet = { keys: [publicJwk] };

  const key: SigningKey = {
    kid: jwk.kid,
    privateKey: await importJWK(jwk, "ES256"),
    publicJwks,
    verificationKeys: createLocalJWKSet(publicJwks),
  };
  cached = { raw, key };
  return key;
}

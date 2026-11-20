import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

/**
 * Creates the ES256 key the backend signs access tokens with and stores it as
 * AUTH_PRIVATE_JWK in backend/.env (git-ignored). The key is never printed, so
 * it cannot end up in terminal scrollback, screenshots or CI logs.
 *
 *   npm run auth:keygen            # adds the key if .env has none
 *   npm run auth:keygen -- --force # replaces it (rotation: all issued tokens stop verifying)
 *
 * For staging/production, run it against a scratch file and paste the value into
 * the platform's secret store instead: ENV_FILE=/tmp/prod.env npm run auth:keygen
 */
const envFile = process.env.ENV_FILE ?? ".env";
const force = process.argv.includes("--force");

let contents = "";
if (fs.existsSync(envFile)) {
  contents = fs.readFileSync(envFile, "utf8");
} else if (envFile === ".env" && fs.existsSync(".env.example")) {
  contents = fs.readFileSync(".env.example", "utf8");
}

const linePattern = /^AUTH_PRIVATE_JWK=.*$/m;
const existing = contents.match(linePattern)?.[0];
if (existing && existing.trim() !== "AUTH_PRIVATE_JWK=" && !force) {
  console.log(`${envFile} already has AUTH_PRIVATE_JWK; pass --force to rotate it.`);
  process.exit(0);
}

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = { ...(await exportJWK(privateKey)), kid: randomUUID(), alg: "ES256", use: "sig" };
const line = `AUTH_PRIVATE_JWK=${JSON.stringify(jwk)}`;

contents = existing ? contents.replace(linePattern, line) : `${contents.replace(/\s*$/, "")}\n${line}\n`;
fs.writeFileSync(envFile, contents, { mode: 0o600 });
console.log(`Wrote AUTH_PRIVATE_JWK (kid=${jwk.kid}) to ${envFile}.`);

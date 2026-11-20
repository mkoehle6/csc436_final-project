import fs from "node:fs";

/**
 * Loads backend/.env into process.env for local development. Must be the first
 * import of every entry point (server, migrate scripts) because modules such as
 * db/client.ts read process.env at import time. Variables already set in the
 * real environment (CI, the hosting platform's secret store) win over the file.
 */
if (fs.existsSync(".env")) {
  process.loadEnvFile(".env");
}

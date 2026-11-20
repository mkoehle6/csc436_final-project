import "./env.js"; // must stay first: loads .env before any module reads process.env
import { createApp } from "./app.js";
import { sqlite } from "./db/client.js";

const port = Number(process.env.PORT ?? 3001);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});

/**
 * Graceful shutdown for Ctrl+C, `tsx watch` restarts and platform stop signals.
 * Closing the database explicitly before exiting matters: letting the process
 * exit with better-sqlite3 still open crashed Node 24 on Windows with
 * "RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr".
 * Closing the HTTP server first also frees the port before a restart rebinds it.
 */
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  // Do not wait forever on keep-alive connections.
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();

  server.close(() => {
    sqlite.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

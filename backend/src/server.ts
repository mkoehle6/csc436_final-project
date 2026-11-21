import "./env.js"; // must stay first: loads .env before any module reads process.env
import { createApp } from "./app.js";
import { closeDb } from "./db/client.js";
import { warmUp } from "./lib/questionBank.js";
import { closeAllStreams } from "./routes/live.js";

const port = Number(process.env.PORT ?? 3001);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
  // Fill the question bank in the background; requests are served meanwhile.
  warmUp((message) => console.log(message)).catch((err: unknown) =>
    console.error("question bank warm-up error", err),
  );
});

/**
 * Graceful shutdown for Ctrl+C, `tsx watch` restarts and platform stop signals
 * (Render sends SIGTERM before replacing an instance during a deploy).
 * Closing the HTTP server first frees the port before a restart rebinds it and
 * lets in-flight requests finish; then the database pool / embedded PGlite is
 * closed so no connection or write is cut off mid-way. (An earlier SQLite build
 * crashed Node 24 on Windows when exiting with the database still open.)
 */
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  // Do not wait forever on keep-alive connections.
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();

  // Open SSE streams would hold server.close() open; ending them lets clients
  // reconnect (with Last-Event-ID) to the next instance and resume (F11).
  closeAllStreams();
  server.close(() => {
    closeDb()
      .catch((err: unknown) => console.error("error closing database", err))
      .finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

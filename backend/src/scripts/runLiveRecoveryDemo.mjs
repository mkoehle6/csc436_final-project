// Runs the F11 kill-and-recover demo: phase 1 and phase 2 of
// liveRecoveryDemo.ts as two separate processes sharing a throwaway database.
//   npm run demo:live-recovery
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-live-demo-"));
const run = (phase) =>
  execFileSync(process.execPath, [tsx, "src/scripts/liveRecoveryDemo.ts", phase, dir], { stdio: "inherit" });

try {
  run("1"); // server A: live event, client drops, two events while away, server stops
  run("2"); // server B (new process): client resumes with Last-Event-ID
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

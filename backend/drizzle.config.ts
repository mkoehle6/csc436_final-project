import { defineConfig } from "drizzle-kit";

// Only used by `npm run db:generate`, which diffs schema.ts against the
// snapshots in src/db/migrations; it never connects to a database.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
});

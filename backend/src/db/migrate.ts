import "../env.js"; // must stay first: loads .env before db/client.js reads DATABASE_URL
import { closeDb, driver, runMigrations } from "./client.js";

await runMigrations();
console.log(`Migrations applied (${driver}).`);
await closeDb();

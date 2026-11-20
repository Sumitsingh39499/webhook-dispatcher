/**
 * Standalone migration CLI - runs the same versioned migrations that the app
 * runs automatically on startup. Useful for manual local runs:
 *
 *   npm run migrate
 *
 * Exits 0 when all pending migrations are applied, 1 on failure.
 */
import { runMigrations } from "../src/db/migrate";
import { closePostgres } from "../src/db/pool";

runMigrations()
  .then((applied) => {
    if (applied.length === 0) {
      console.log("[migrate] no pending migrations");
    } else {
      console.log(`[migrate] applied: ${applied.join(", ")}`);
    }
    return closePostgres().then(() => process.exit(0));
  })
  .catch((err) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  });

import { readdirSync } from "fs";
import { join } from "path";
import { pgPool } from "./pool";

/**
 * Minimal, versioned migration runner using the same numbering scheme for both
 * local CLI runs (tsx scripts/migrate.ts) and startup auto-migration.
 *
 * - Each file in migrations/ is named <version>_<name>.ts and exports up/down.
 * - Applied versions are recorded in the schema_migrations table.
 * - Running with no pending migrations is a no-op (idempotent), which keeps the
 *   Render free-tier single-service deployment simple: the app migrates itself
 *   on boot instead of needing a separate migration job.
 *
 * File discovery accepts both .ts (running from source via tsx) and .js
 * (running from the compiled dist/ output) so dev and production behave
 * identically.
 */
export interface Migration {
  up: (client: import("pg").PoolClient) => Promise<void>;
  down?: (client: import("pg").PoolClient) => Promise<void>;
}

interface DiscoveredMigration {
  version: string;
  name: string;
  path: string;
}

function migrationsDir(): string {
  // src/db/migrate.ts -> ../../migrations (source), dist/src/db/migrate.js ->
  // ../../migrations == dist/migrations (compiled). Both resolve correctly.
  return join(__dirname, "..", "..", "migrations");
}

async function ensureMigrationsTable(client: import("pg").PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrations(): Promise<DiscoveredMigration[]> {
  const files = readdirSync(migrationsDir()).filter((f) => /^\d+_.+\.(js|ts)$/.test(f));
  return files
    .map((f) => {
      const [version, ...rest] = f.replace(/\.(js|ts)$/, "").split("_");
      return { version, name: rest.join("_"), path: join(migrationsDir(), f) };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

export async function runMigrations(): Promise<string[]> {
  const client = await pgPool.connect();
  const applied: string[] = [];
  try {
    await client.query("BEGIN");
    await ensureMigrationsTable(client);

    const result = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations"
    );
    const done = new Set(result.rows.map((r) => r.version));

    for (const migration of await listMigrations()) {
      if (done.has(migration.version)) continue;

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(migration.path) as Migration;
      await mod.up(client);
      await client.query(
        "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name]
      );
      applied.push(`${migration.version}_${migration.name}`);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return applied;
}

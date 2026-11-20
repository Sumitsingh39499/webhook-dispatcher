import { Pool } from "pg";
import { env } from "../config/env";

/**
 * Shared PostgreSQL connection pool. One pool per process; both the Express API
 * and the BullMQ worker (same process on Render free tier) use it.
 */
export const pgPool = new Pool({
  ...env.pg,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pgPool.on("error", (err) => {
  // Log clearly rather than silently swallowing (per spec 4.6).
  console.error("[postgres] idle pool error:", err.message);
});

export async function checkPostgres(): Promise<void> {
  const client = await pgPool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

export async function closePostgres(): Promise<void> {
  await pgPool.end();
}
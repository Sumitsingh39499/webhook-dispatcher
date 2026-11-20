import type { PoolClient } from "pg";

/**
 * One row per actual outbound HTTP delivery attempt.
 * Rate-limit deferrals do NOT insert rows (not HTTP attempts).
 *
 * status is restricted to the three approved values:
 *   retrying | success | failed
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE delivery_attempts (
      id              BIGSERIAL PRIMARY KEY,
      job_id          TEXT NOT NULL,
      event_id        TEXT NOT NULL,
      destination_url TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('retrying', 'success', 'failed')),
      response_code   INTEGER,
      error_details   TEXT,
      attempt_count   INTEGER NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE INDEX idx_delivery_attempts_job_id ON delivery_attempts (job_id)
  `);

  await client.query(`
    CREATE INDEX idx_delivery_attempts_created_at ON delivery_attempts (created_at)
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS delivery_attempts`);
}

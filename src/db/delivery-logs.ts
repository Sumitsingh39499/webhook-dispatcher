import { pgPool } from "../db/pool";

export type DeliveryStatus = "retrying" | "success" | "failed";

export interface RecordAttemptInput {
  jobId: string;
  eventId: string;
  destinationUrl: string;
  status: DeliveryStatus;
  responseCode: number | null;
  errorDetails: string | null;
  attemptCount: number;
}

/**
 * Insert one delivery-attempt row. PostgreSQL write errors are logged clearly
 * and rethrown so the worker can decide what to do (spec 4.6 - do not swallow).
 */
export async function recordDeliveryAttempt(input: RecordAttemptInput): Promise<void> {
  try {
    await pgPool.query(
      `
      INSERT INTO delivery_attempts
        (job_id, event_id, destination_url, status, response_code, error_details, attempt_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.jobId,
        input.eventId,
        input.destinationUrl,
        input.status,
        input.responseCode,
        input.errorDetails,
        input.attemptCount,
      ]
    );
  } catch (err) {
    console.error(
      `[delivery-log] failed to persist attempt for job=${input.jobId} attempt=${input.attemptCount}:`,
      err
    );
    throw err;
  }
}

export interface DeliveryAttemptRow {
  id: number;
  jobId: string;
  eventId: string;
  destinationUrl: string;
  status: DeliveryStatus;
  responseCode: number | null;
  errorDetails: string | null;
  attemptCount: number;
  createdAt: Date;
}

export async function getDeliveryAttempts(jobId: string): Promise<DeliveryAttemptRow[]> {
  const result = await pgPool.query<DeliveryAttemptRow>(
    `
    SELECT id, job_id AS "jobId", event_id AS "eventId",
           destination_url AS "destinationUrl", status, response_code AS "responseCode",
           error_details AS "errorDetails", attempt_count AS "attemptCount",
           created_at AS "createdAt"
    FROM delivery_attempts
    WHERE job_id = $1
    ORDER BY attempt_count ASC, id ASC
    `,
    [jobId]
  );
  return result.rows;
}

import axios, { AxiosError } from "axios";
import { Worker, type Job } from "bullmq";
import { DelayedError, UnrecoverableError } from "bullmq";
import { destinationHostname } from "../security/ssrf";
import { TokenBucket } from "../rate-limit/token-bucket";
import { recordDeliveryAttempt, type DeliveryStatus } from "../db/delivery-logs";
import { createRedisConnection } from "../redis/connection";
import { QUEUE_NAMES, getDlqQueue } from "../queue/queues";

const HTTP_TIMEOUT_MS = 5_000;
const RATE_LIMIT_MAX_DELAY_MS = 30_000; // safety cap; bucket refills 1/s so ~<=1s normally

/** Standard BullMQ job data for a webhook delivery. */
export interface WebhookJobData {
  destinationUrl: string;
  eventId: string;
  payload: Record<string, unknown>;
  /** Number of actual outbound HTTP attempts made so far (not BullMQ ats). */
  httpAttempt?: number;
}

function statusFromResponse(code: number | null, err: AxiosError | null): {
  retryable: boolean;
  failed: boolean; // true => DLQ now (non-retryable)
} {
  // Timeout / network errors (no response)
  if (err && !err.response) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { retryable: true, failed: false }; // HTTP timeout - retryable (spec 4.4)
    }
    // Other network errors (ECONNREFUSED, ENOTFOUND, ECONNRESET, TLS...)
    return { retryable: true, failed: false };
  }

  const code2xx = code !== null && code >= 200 && code < 300;
  if (code2xx) {
    return { retryable: false, failed: false };
  }
  if (code === null) {
    return { retryable: true, failed: false };
  }

  if (code === 429) {
    return { retryable: true, failed: false };
  }
  if (code >= 500 && code <= 599) {
    return { retryable: true, failed: false };
  }
  if (code >= 300 && code < 400) {
    // Redirects are disabled; 3xx is a non-retryable failure (spec 4.3).
    return { retryable: false, failed: true };
  }
  if (code >= 400 && code < 500) {
    // Other 4xx: non-retryable, straight to DLQ (spec 4.3).
    return { retryable: false, failed: true };
  }
  return { retryable: true, failed: false };
}

function describeError(err: AxiosError | null): string {
  if (!err) return "unknown error";
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
    return `timeout after ${HTTP_TIMEOUT_MS}ms`;
  }
  if (err.response) {
    return `HTTP ${err.response.status}`;
  }
  return err.message;
}

/**
 * Delivery worker. One instance per process (Render free tier: same process
 * as the Express API).
 */
export class DeliveryWorker {
  private worker: Worker | null = null;
  private tokenBucket: TokenBucket | null = null;

  async start(): Promise<void> {
    this.tokenBucket = new TokenBucket(createRedisConnection(), 5, 1);

    this.worker = new Worker<WebhookJobData>(QUEUE_NAMES.delivery, this.process, {
      connection: createRedisConnection(),
      concurrency: 5,
      // Do not auto-reattach completed/failed jobs; we manage DLQ explicitly.
      lockDuration: 30_000,
    });

    this.worker.on("error", (err) => {
      // Worker-level errors (not job failures) - log, do not crash.
      console.error("[worker] error:", err.message);
    });

    // Transfer UnrecoverableError jobs to DLQ exactly once.
    this.worker.on("failed", async (job, err) => {
      if (!job || !(err instanceof UnrecoverableError)) {
        return;
      }

      const data = job.data;
      const failedReason = err.message || job.failedReason || "unknown";
      await getDlqQueue().add(
        "webhook-dead",
        {
          originalJobId: job.id,
          destinationUrl: data.destinationUrl,
          eventId: data.eventId,
          payload: data.payload,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts,
          failedReason,
          failedAt: new Date().toISOString(),
          originalName: job.name,
        },
        { jobId: job.id as string }
      );
      console.warn(
        `[dlq] status=dlq job=${job.id} eventId=${data.eventId} moved to DLQ: ${failedReason}`
      );
    });

    console.log("[worker] delivery worker started");
  }

  private process = async (job: Job<WebhookJobData>): Promise<void> => {
    const { destinationUrl, eventId, payload } = job.data;
    const hostname = destinationHostname(destinationUrl);

    // HTTP attempt number lives in job data so rate-limit deferrals (which
    // bump BullMQ's ats but not atm) never inflate it.
    let httpAttempt = job.data.httpAttempt ?? 0;

    // ---- Rate limit: defer WITHOUT consuming an HTTP attempt ----
    const bucket = this.tokenBucket!;
    const grant = await bucket.consume(hostname);
    if (!grant.allowed) {
      const delay = Math.min(grant.waitMs, RATE_LIMIT_MAX_DELAY_MS);
      console.log(
        `[worker] rate-limited host=${hostname} job=${job.id} attempt=${httpAttempt} wait=${delay}ms (not consuming retry)`
      );
      // skipAttempt: true inside job.moveToDelayed -> atm is NOT incremented.
      await job.moveToDelayed(Date.now() + delay, job.token ?? "0");
      throw new DelayedError();
    }

    // ---- Actual HTTP attempt (consumes one token; counts as an attempt) ----
    httpAttempt += 1;
    await job.updateData({ ...job.data, httpAttempt });
    console.log(
      `[worker] POST ${destinationUrl} job=${job.id} eventId=${eventId} attempt=${httpAttempt} tokensLeft=${grant.remainingTokens}`
    );

    let responseCode: number | null = null;
    let axiosErr: AxiosError | null = null;

    try {
      const response = await axios.post(destinationUrl, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: HTTP_TIMEOUT_MS,
        maxRedirects: 0, // never follow (spec 4.2/4.3)
        validateStatus: () => true, // we classify statuses ourselves
        // Do not throw on 3xx/4xx/5xx
      });
      responseCode = response.status;
    } catch (err) {
      axiosErr = err as AxiosError;
    }

    const classification = statusFromResponse(responseCode, axiosErr);
    const errorText = axiosErr ? describeError(axiosErr) : null;

    // Determine the PG status. The LAST attempt (no more retries) is "failed",
    // earlier retryable failures are "retrying".
    let pgStatus: DeliveryStatus;
    if (responseCode !== null && responseCode >= 200 && responseCode < 300) {
      pgStatus = "success";
    } else if (classification.failed) {
      pgStatus = "failed";
    } else if (classification.retryable) {
      // Remaining HTTP attempts after this one.
      const remaining = 4 - httpAttempt;
      pgStatus = remaining > 0 ? "retrying" : "failed";
    } else {
      pgStatus = "failed";
    }

    try {
      await recordDeliveryAttempt({
        jobId: job.id as string,
        eventId,
        destinationUrl,
        status: pgStatus,
        responseCode,
        errorDetails: errorText,
        attemptCount: httpAttempt,
      });
    } catch (pgErr) {
      // Already logged inside recordDeliveryAttempt. If we cannot persist
      // history, treat as a transient infrastructure error: let BullMQ retry
      // this attempt (it will re-consume a token, which is correct).
      throw pgErr;
    }

    if (pgStatus === "success") {
      console.log(`[worker] success job=${job.id} attempt=${httpAttempt} code=${responseCode}`);
      return;
    }

    if (classification.failed) {
      // Non-retryable (4xx except 429, or 3xx) -> fail without further retries.
      console.warn(
        `[worker] non-retryable job=${job.id} attempt=${httpAttempt} code=${responseCode} -> DLQ`
      );
      throw new UnrecoverableError(errorText ?? `HTTP ${responseCode}`);
    }

    if (httpAttempt >= 4) {
      // Exhausted the approved 4 HTTP attempts. UnrecoverableError sends this
      // straight to the failed state (and the DLQ router) without another try.
      console.warn(
        `[worker] exhausted job=${job.id} attempt=${httpAttempt} code=${responseCode} err=${errorText}`
      );
      throw new UnrecoverableError(errorText ?? `HTTP ${responseCode}`);
    }

    // Retryable failure: throw so BullMQ applies exponential backoff (2s, 4s, 8s).
    const err = axiosErr ?? new Error(errorText ?? `HTTP ${responseCode}`);
    console.warn(
      `[worker] retryable failure job=${job.id} attempt=${httpAttempt} code=${responseCode} err=${errorText}`
    );
    throw err;
  };

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}

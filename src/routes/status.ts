import { Router } from "express";
import { getDeliveryQueue, getDlqQueue } from "../queue/queues";
import { getDeliveryAttempts, type DeliveryAttemptRow } from "../db/delivery-logs";
import type { WebhookJobData } from "../worker/delivery";

const router = Router();

/**
 * Operational states (spec 4.10) - distinct from PostgreSQL delivery statuses
 * (retrying | success | failed).
 */
type OperationalStatus =
  | "queued"
  | "active"
  | "delayed"
  | "completed"
  | "failed"
  | "dlq";

function mapBullMqState(state: string): OperationalStatus {
  switch (state) {
    case "waiting":
    case "waiting-children":
      return "queued";
    case "active":
      return "active";
    case "delayed":
      return "delayed";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function serializeAttempt(row: DeliveryAttemptRow) {
  return {
    id: row.id,
    jobId: row.jobId,
    eventId: row.eventId,
    destinationUrl: row.destinationUrl,
    status: row.status, // retrying | success | failed
    responseCode: row.responseCode,
    errorDetails: row.errorDetails,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

/**
 * GET /api/webhooks/:jobId
 *
 * BullMQ provides current operational state; PostgreSQL provides historical
 * HTTP delivery attempts; the DLQ represents permanently failed jobs.
 */
router.get("/api/webhooks/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

  const [deliveryJob, dlqJob, history] = await Promise.all([
    getDeliveryQueue().getJob(jobId),
    getDlqQueue().getJob(jobId),
    getDeliveryAttempts(jobId),
  ]);

  if (!deliveryJob && !dlqJob && history.length === 0) {
    res.status(404).json({ error: "not_found", jobId });
    return;
  }

  let status: OperationalStatus;
  if (dlqJob) {
    status = "dlq";
  } else if (deliveryJob) {
    status = mapBullMqState(await deliveryJob.getState());
  } else {
    // Job evicted from Redis (removeOnComplete/Fail windows); derive from PG.
    const last = history[history.length - 1];
    status = last?.status === "success" ? "completed" : "failed";
  }

  const data = (deliveryJob?.data ?? dlqJob?.data) as WebhookJobData | undefined;
  const httpAttemptCount =
    history.length > 0
      ? Math.max(...history.map((h) => h.attemptCount))
      : data?.httpAttempt ?? 0;

  const response: Record<string, unknown> = {
    jobId,
    eventId: data?.eventId ?? history[0]?.eventId ?? null,
    destinationUrl: data?.destinationUrl ?? history[0]?.destinationUrl ?? null,
    status,
    httpAttemptCount,
    deliveryHistory: history.map(serializeAttempt),
  };

  if (deliveryJob) {
    response.bullmq = {
      state: await deliveryJob.getState(),
      attemptsMade: deliveryJob.attemptsMade,
      maxAttempts: deliveryJob.opts.attempts ?? null,
      processedOn: deliveryJob.processedOn ? new Date(deliveryJob.processedOn).toISOString() : null,
      finishedOn: deliveryJob.finishedOn ? new Date(deliveryJob.finishedOn).toISOString() : null,
      failedReason: deliveryJob.failedReason ?? null,
    };
  }

  if (status === "failed" && deliveryJob) {
    response.failure = {
      failedReason: deliveryJob.failedReason ?? null,
      attemptsMade: deliveryJob.attemptsMade,
      maxAttempts: deliveryJob.opts.attempts ?? null,
    };
  }

  if (dlqJob) {
    const dlqData = dlqJob.data as {
      originalJobId?: string;
      failedReason?: string;
      failedAt?: string;
      attemptsMade?: number;
      maxAttempts?: number;
    };
    response.dlq = {
      jobId: dlqJob.id,
      failedReason: dlqData.failedReason ?? dlqJob.failedReason ?? null,
      failedAt: dlqData.failedAt ?? (dlqJob.finishedOn ? new Date(dlqJob.finishedOn).toISOString() : null),
      attemptsMade: dlqData.attemptsMade ?? dlqJob.attemptsMade,
      maxAttempts: dlqData.maxAttempts ?? null,
    };
  }

  res.status(200).json(response);
  } catch (err) {
    console.error("[status] error:", err);
    res.status(500).json({ error: "internal_error", message: (err as Error).message });
  }
});

export default router;

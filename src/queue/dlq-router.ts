import { QueueEvents } from "bullmq";
import { createRedisConnection } from "../redis/connection";
import { getDeliveryQueue, getDlqQueue, QUEUE_NAMES } from "../queue/queues";
import type { WebhookJobData } from "../worker/delivery";

/**
 * Routes permanently failed delivery jobs into the Dead Letter Queue.
 *
 * A separate QueueEvents listener is used because Worker 'failed' events are
 * not reliably emitted when a job exhausts its retries on its last attempt
 * (BullMQ v5 processJob uses retryIfFailed(..., onlyEmitError) around
 * handleFailed, which swallows errors). QueueEvents uses the job's Redis
 * event stream. Terminal failures emit `retries-exhausted` (exhaustion or
 * UnrecoverableError); that is the DLQ trigger.
 *
 * Duplicate-transfer protection (spec 4.5): the DLQ job uses the original
 * jobId. Adding a job with an existing jobId is a no-op in BullMQ, so a
 * restarted worker or replayed event cannot create a second DLQ entry.
 */
export class DlqRouter {
  private events: QueueEvents | null = null;

  async start(): Promise<void> {
    this.events = new QueueEvents(QUEUE_NAMES.delivery, {
      connection: createRedisConnection(),
    });
    await this.events.waitUntilReady();

    this.events.on("retries-exhausted", async ({ jobId }) => {
      try {
        await this.transferToDlq(jobId, null);
      } catch (err) {
        console.error(`[dlq] failed processing retries-exhausted for job=${jobId}:`, err);
      }
    });

    this.events.on("error", (err) => {
      console.error("[dlq] queue-events error:", err.message);
    });

    console.log("[dlq] DLQ router listening on delivery queue events");
  }

  private async transferToDlq(jobId: string, failedReason: string | null): Promise<void> {
    const job = await getDeliveryQueue().getJob(jobId);
    if (!job) {
      console.warn(`[dlq] job ${jobId} disappeared before DLQ transfer`);
      return;
    }
    const data = job.data as WebhookJobData;
    const dlq = getDlqQueue();
    await dlq.add(
      "webhook-dead",
      {
        originalJobId: job.id,
        destinationUrl: data.destinationUrl,
        eventId: data.eventId,
        payload: data.payload,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        failedReason: failedReason ?? job.failedReason ?? "unknown",
        failedAt: new Date().toISOString(),
        originalName: job.name,
      },
      {
        jobId: job.id as string,
      }
    );
    console.warn(
      `[dlq] job=${job.id} eventId=${data.eventId} moved to DLQ: ${failedReason ?? job.failedReason}`
    );
  }

  async close(): Promise<void> {
    if (this.events) {
      await this.events.close();
      this.events = null;
    }
  }
}

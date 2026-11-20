import { Queue } from "bullmq";
import { createRedisConnection } from "../redis/connection";

/**
 * Queue names. The delivery queue is the main webhook queue; the DLQ is a
 * separate BullMQ queue holding permanently failed jobs.
 */
export const QUEUE_NAMES = {
  delivery: "webhook-delivery",
  dlq: "webhook-dlq",
} as const;

let deliveryQueue: Queue | null = null;
let dlqQueue: Queue | null = null;

/**
 * The main webhook delivery queue (producer side). One instance per process.
 *
 * Job options implement the approved retry configuration:
 *   attempts: 4  (initial attempt + 3 retries)
 *   backoff: exponential, 2000ms base  ->  2s, 4s, 8s
 */
export function getDeliveryQueue(): Queue {
  if (deliveryQueue === null) {
    deliveryQueue = new Queue(QUEUE_NAMES.delivery, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 4,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    });
  }
  return deliveryQueue;
}

/** The dead letter queue (separate queue, NOT the delivery queue's failed set). */
export function getDlqQueue(): Queue {
  if (dlqQueue === null) {
    dlqQueue = new Queue(QUEUE_NAMES.dlq, {
      connection: createRedisConnection(),
    });
  }
  return dlqQueue;
}

export async function closeQueues(): Promise<void> {
  if (deliveryQueue !== null) {
    await deliveryQueue.close();
    deliveryQueue = null;
  }
  if (dlqQueue !== null) {
    await dlqQueue.close();
    dlqQueue = null;
  }
}

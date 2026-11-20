import { Router } from "express";
import { randomUUID } from "crypto";
import { dispatchSchema } from "../validation/dispatch";
import { assertSafeDestination, InvalidDestinationError } from "../security/ssrf";
import { getDeliveryQueue } from "../queue/queues";
import type { WebhookJobData } from "../worker/delivery";
import { env } from "../config/env";

const router = Router();

/**
 * POST /api/webhooks/dispatch
 *
 * Validates, enqueues on BullMQ, and returns 202 immediately.
 * Never waits for downstream HTTP delivery.
 * 503 if Redis enqueue fails.
 */
router.post("/api/webhooks/dispatch", async (req, res) => {
  const parsed = dispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "validation_failed",
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const { destinationUrl, eventId, payload } = parsed.data;

  try {
    await assertSafeDestination(destinationUrl);
  } catch (err) {
    if (err instanceof InvalidDestinationError) {
      res.status(400).json({ error: "invalid_destination", message: err.message });
      return;
    }
    throw err;
  }

  // Unique jobId per accepted request. Never use eventId (duplicates allowed).
  const jobId = `job_${randomUUID()}`;

  try {
    const queue = getDeliveryQueue();
    const rawClient: unknown = await Promise.race([
      queue.client,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("redis client not ready (timeout)")), 2000)
      ),
    ]);
    const client = rawClient as { status: string };
    if (client.status !== "ready") {
      throw new Error(`redis not ready (status=${client.status})`);
    }
    const data: WebhookJobData = { destinationUrl, eventId, payload };
    await Promise.race([
      queue.add("webhook-delivery", data, { jobId }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("redis enqueue timeout")), 2000)
      ),
    ]);
  } catch (err) {
    console.error("[dispatch] redis enqueue failed:", err);
    res.status(503).json({ error: "queue_unavailable", message: "failed to enqueue webhook" });
    return;
  }

  // 202 immediately after successful enqueue - do NOT wait for delivery.
  res.status(202).json({ status: "queued", jobId });
});

export default router;

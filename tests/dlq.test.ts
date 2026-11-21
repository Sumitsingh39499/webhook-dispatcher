import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const callbacks = new Map<string, (...args: any[]) => unknown>();
  return {
    callbacks,
    dlqAdd: vi.fn().mockResolvedValue({ id: "job-404" }),
  };
});

vi.mock("bullmq", () => ({
  QueueEvents: class {
    waitUntilReady = vi.fn().mockResolvedValue(undefined);
    on(event: string, callback: (...args: any[]) => unknown) {
      mocks.callbacks.set(event, callback);
    }
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../src/redis/connection", () => ({
  createRedisConnection: vi.fn(() => ({})),
}));

vi.mock("../src/queue/queues", () => ({
  QUEUE_NAMES: { delivery: "webhook-delivery", dlq: "webhook-dlq" },
  getDeliveryQueue: vi.fn(() => ({
    getJob: vi.fn().mockResolvedValue({
      id: "job-404",
      data: {
        destinationUrl: "https://example.com/hook",
        eventId: "event-404",
        payload: {},
      },
      attemptsMade: 1,
      opts: { attempts: 4 },
      failedReason: "HTTP 404",
      name: "webhook-delivery",
    }),
  })),
  getDlqQueue: vi.fn(() => ({ add: mocks.dlqAdd })),
}));

import { DlqRouter } from "../src/queue/dlq-router";

describe("DLQ routing", () => {
  it("routes terminal failures with the original jobId and duplicate protection", async () => {
    const router = new DlqRouter();
    await router.start();
    await mocks.callbacks.get("retries-exhausted")?.({ jobId: "job-404" });

    expect(mocks.dlqAdd).toHaveBeenCalledOnce();
    const [name, data, options] = mocks.dlqAdd.mock.calls[0] as [string, Record<string, unknown>, { jobId: string }];
    expect(name).toBe("webhook-dead");
    expect(options.jobId).toBe("job-404");
    expect(data.originalJobId).toBe("job-404");
    expect(data.attemptsMade).toBe(1);
    expect(data.failedReason).toBe("HTTP 404");
  });
});

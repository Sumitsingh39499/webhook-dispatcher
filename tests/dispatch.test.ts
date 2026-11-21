import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  queueClient: { status: "ready" },
}));

vi.mock("../src/queue/queues", () => ({
  getDeliveryQueue: () => ({
    client: Promise.resolve(mocks.queueClient),
    add: mocks.queueAdd,
  }),
  QUEUE_NAMES: { delivery: "webhook-delivery", dlq: "webhook-dlq" },
}));

vi.mock("../src/security/ssrf", async () => {
  const actual = await vi.importActual<typeof import("../src/security/ssrf")>("../src/security/ssrf");
  return {
    ...actual,
    assertSafeDestination: vi.fn(async () => undefined),
  };
});

import dispatchRouter from "../src/routes/dispatch";

function app() {
  const value = express();
  value.use(express.json());
  value.use(dispatchRouter);
  return value;
}

beforeEach(() => {
  mocks.queueClient.status = "ready";
  mocks.queueAdd.mockReset();
  mocks.queueAdd.mockResolvedValue({ id: "test-job" });
});

afterEach(() => vi.clearAllMocks());

describe("dispatch ingestion", () => {
  it("returns 202 immediately and enqueues a valid webhook", async () => {
    const res = await request(app()).post("/api/webhooks/dispatch").send({
      destinationUrl: "https://example.com/hooks",
      eventId: "event-1",
      payload: { ok: true },
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.jobId).toMatch(/^job_[0-9a-f-]{36}$/);
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it("rejects invalid destination and event payload", async () => {
    const res = await request(app()).post("/api/webhooks/dispatch").send({
      destinationUrl: "ftp://example.com",
      eventId: "",
      payload: null,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
  });

  it("returns 503 when Redis enqueue fails", async () => {
    mocks.queueAdd.mockRejectedValue(new Error("redis unavailable"));
    const res = await request(app()).post("/api/webhooks/dispatch").send({
      destinationUrl: "https://example.com/hooks",
      eventId: "event-503",
      payload: {},
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("queue_unavailable");
  });

  it("returns 503 when Redis client is not ready", async () => {
    mocks.queueClient.status = "connecting";
    const res = await request(app()).post("/api/webhooks/dispatch").send({
      destinationUrl: "https://example.com/hooks",
      eventId: "event-ready",
      payload: {},
    });
    expect(res.status).toBe(503);
  });

  it("creates unique jobIds and permits duplicate eventIds", async () => {
    const first = await request(app()).post("/api/webhooks/dispatch").send({
      destinationUrl: "https://example.com/hooks",
      eventId: "duplicate-event",
      payload: { attempt: 1 },
    });
    const second = await request(app()).post("/api/webhooks/dispatch").send({
      destinationUrl: "https://example.com/hooks",
      eventId: "duplicate-event",
      payload: { attempt: 2 },
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.jobId).not.toBe(second.body.jobId);
  });
});

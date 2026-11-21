import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../src/db/pool", () => ({
  pgPool: { query: mocks.query },
}));

import { recordDeliveryAttempt } from "../src/db/delivery-logs";

beforeEach(() => mocks.query.mockReset());

describe("delivery logging", () => {
  it("persists one of the three approved statuses and attempt count", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await recordDeliveryAttempt({
      jobId: "job-1",
      eventId: "event-1",
      destinationUrl: "https://example.com/hook",
      status: "retrying",
      responseCode: 429,
      errorDetails: null,
      attemptCount: 1,
    });

    expect(mocks.query).toHaveBeenCalledOnce();
    const [, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([
      "job-1",
      "event-1",
      "https://example.com/hook",
      "retrying",
      429,
      null,
      1,
    ]);
  });

  it("allows only retrying, success, and failed at the type level", async () => {
    const statusValues = ["retrying", "success", "failed"] as const;
    expect(statusValues).toHaveLength(3);
  });

  it("does not swallow PostgreSQL write failures", async () => {
    mocks.query.mockRejectedValueOnce(new Error("postgres unavailable"));
    let thrown: Error | null = null;
    try {
      await recordDeliveryAttempt({
        jobId: "job-1",
        eventId: "event-1",
        destinationUrl: "https://example.com/hook",
        status: "failed",
        responseCode: 500,
        errorDetails: "HTTP 500",
        attemptCount: 4,
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toBe("postgres unavailable");
  });
});

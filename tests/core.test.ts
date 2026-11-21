import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";
import { dispatchSchema } from "../src/validation/dispatch";
import { isProhibitedDestinationIp, destinationHostname } from "../src/security/ssrf";
import { HTTP_TIMEOUT_MS, statusFromResponse } from "../src/worker/delivery";
import { DELIVERY_QUEUE_ATTEMPTS, DELIVERY_QUEUE_BACKOFF_DELAY_MS } from "../src/queue/queues";
import { TokenBucket } from "../src/rate-limit/token-bucket";

describe("validation", () => {
  it("accepts absolute HTTP(S) URLs and required fields", () => {
    expect(dispatchSchema.safeParse({
      destinationUrl: "https://example.com/hook",
      eventId: "event-1",
      payload: {},
    }).success).toBe(true);
  });

  it("rejects missing eventId and non-object payload", () => {
    expect(dispatchSchema.safeParse({
      destinationUrl: "https://example.com/hook",
      eventId: "",
      payload: null,
    }).success).toBe(false);
  });
});

describe("token bucket", () => {
  it("uses 5-token capacity and 1 token/second refill arguments", async () => {
    const evalMock = async (...args: unknown[]) => {
      expect(args[1]).toBe(1);
      expect(args[2]).toBe("tb:example.com");
      expect(args[3]).toBe(5);
      expect(args[4]).toBe(1);
      expect(args[5]).toBeTypeOf("number");
      expect(args[6]).toBe(1);
      return [1, 4, 0];
    };
    const bucket = new TokenBucket({ eval: evalMock } as never, 5, 1);
    const result = await bucket.consume("example.com");
    expect(result).toEqual({ allowed: true, remainingTokens: 4, waitMs: 0 });
  });
});

describe("retry and timeout policy", () => {
  it("uses four attempts and an exponential 2000ms base", () => {
    expect(DELIVERY_QUEUE_ATTEMPTS).toBe(4);
    expect(DELIVERY_QUEUE_BACKOFF_DELAY_MS).toBe(2000);
    expect(HTTP_TIMEOUT_MS).toBe(5000);
  });

  it("classifies 429 and 5xx as retryable", () => {
    expect(statusFromResponse(429, null)).toEqual({ retryable: true, failed: false });
    expect(statusFromResponse(500, null)).toEqual({ retryable: true, failed: false });
  });

  it("classifies 404 as non-retryable and 2xx as success", () => {
    expect(statusFromResponse(404, null)).toEqual({ retryable: false, failed: true });
    expect(statusFromResponse(200, null)).toEqual({ retryable: false, failed: false });
  });

  it("classifies timeout and network errors as retryable", () => {
    const timeout = new AxiosError("timeout");
    timeout.code = "ECONNABORTED";
    expect(statusFromResponse(null, timeout)).toEqual({ retryable: true, failed: false });
  });
});

describe("basic SSRF policy", () => {
  it("rejects loopback and private IPv4 addresses", () => {
    expect(isProhibitedDestinationIp("127.0.0.1")).toBe(true);
    expect(isProhibitedDestinationIp("10.0.0.1")).toBe(true);
  });

  it("allows ordinary public IPv4 range and extracts hostname", () => {
    expect(isProhibitedDestinationIp("8.8.8.8")).toBe(false);
    expect(destinationHostname("https://Example.COM:8443/hook")).toBe("example.com");
  });
});

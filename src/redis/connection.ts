import IORedis, { type Redis } from "ioredis";
import { env } from "../config/env";

/**
 * Redis connection factory.
 *
 * BullMQ requires connections with maxRetriesPerRequest: null (it issues
 * blocking commands such as BRPOPLPUSH/BLPOP that must not be rejected while
 * waiting). We create:
 *  - one shared connection for general commands (API side, queue admin),
 *  - dedicated connections inside BullMQ Queue/Worker instances themselves.
 */
export function createRedisConnection(): Redis {
  const common = {
    // Required by BullMQ: blocking commands must not be rejected while waiting.
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  };
  if (env.redis.connectionUrl !== undefined) {
    return new IORedis(env.redis.connectionUrl, common);
  }
  return new IORedis({
    host: env.redis.host,
    port: env.redis.port,
    ...common,
  });
}

let sharedRedis: Redis | null = null;

/** Shared connection used by the API and queue administration. */
export function getSharedRedis(): Redis {
  if (sharedRedis === null) {
    sharedRedis = createRedisConnection();
  }
  return sharedRedis;
}

/** Connectivity probe used by /health and startup checks. */
export async function checkRedis(timeoutMs = 2000): Promise<void> {
  const client = getSharedRedis();

  if (client.status !== "ready") {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Redis not ready (status=${client.status})`));
      }, timeoutMs);

      const onReady = () => {
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Redis connection error: ${err.message}`));
      };

      const cleanup = () => {
        clearTimeout(timer);
        client.off("ready", onReady);
        client.off("error", onError);
      };

      client.once("ready", onReady);
      client.once("error", onError);
    });
  }

  const pong = await client.ping();
  if (pong !== "PONG") {
    throw new Error(`Redis PING returned unexpected value: ${pong}`);
  }
}

export async function closeRedis(): Promise<void> {
  if (sharedRedis !== null) {
    sharedRedis.disconnect();
    sharedRedis = null;
  }
}

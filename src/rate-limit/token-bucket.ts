import type Redis from "ioredis";

/**
 * Atomic token bucket (spec 4.7).
 *
 * KEYS[1] bucket key (per destination hostname)
 * ARGV[1] capacity (tokens)
 * ARGV[2] refill rate (tokens per second)
 * ARGV[3] now in milliseconds
 * ARGV[4] requested tokens (always 1)
 *
 * Returns:
 *   {1, remaining}         allowed
 *   {0, waitMilliseconds}  denied; wait at least this long for 1 token
 *
 * State: HMSET key tokens last_refill_ms
 */
const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last = tonumber(bucket[2])

if tokens == nil or last == nil then
  tokens = capacity
  last = now
end

local elapsed = now - last
if elapsed < 0 then
  elapsed = 0
end

tokens = math.min(capacity, tokens + (elapsed / 1000.0) * rate)

local allowed = 0
local waitMs = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  waitMs = math.ceil(((requested - tokens) / rate) * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('PEXPIRE', key, math.ceil((capacity / rate) * 1000) + 1000)

return {allowed, math.floor(tokens), waitMs}
`;

export interface TokenBucketResult {
  allowed: boolean;
  remainingTokens: number;
  waitMs: number;
}

export class TokenBucket {
  constructor(
    private readonly redis: Redis,
    private readonly capacity = 5,
    private readonly refillPerSecond = 1
  ) {}

  /**
   * Consume one token for hostname. Every actual outbound HTTP request
   * (including retries) must call this - spec 4.7.
   */
  async consume(hostname: string): Promise<TokenBucketResult> {
    const key = `tb:${hostname}`;
    const result = (await this.redis.eval(
      LUA,
      1,
      key,
      this.capacity,
      this.refillPerSecond,
      Date.now(),
      1
    )) as [number, number, number];

    return {
      allowed: result[0] === 1,
      remainingTokens: result[1],
      waitMs: result[2],
    };
  }
}

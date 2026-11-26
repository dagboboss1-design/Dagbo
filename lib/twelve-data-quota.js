"use strict";

const QUOTA_KEY = "dagbo:market:twelve:minute";
const DEFAULT_LIMIT = 7;

/**
 * Reserve one account-wide Twelve Data credit slot atomically.
 * All serverless routes must use the same Redis key so concurrent scans,
 * news checks and quote requests cannot overspend the provider's per-minute cap.
 * Throws when Redis cannot reserve a slot: callers must fail closed.
 */
async function claimTwelveDataSlot(redis, limit = DEFAULT_LIMIT) {
  if (!redis || typeof redis.eval !== "function") {
    throw new Error("Shared Twelve Data quota store is unavailable");
  }
  const raw = await redis.eval(
    "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], 60); end; return count",
    [QUOTA_KEY],
    []
  );
  const count = Number(raw);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error("Shared Twelve Data quota reservation returned an invalid count");
  }
  return count <= limit;
}

module.exports = { claimTwelveDataSlot, QUOTA_KEY, DEFAULT_LIMIT };

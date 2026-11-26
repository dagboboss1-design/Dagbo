const { Redis } = require("@upstash/redis");
const { claimTwelveDataSlot } = require("../lib/twelve-data-quota");

const CACHE_KEY = "dagbo:fx:usd-ngn:v1";
const FRESH_MS = 10 * 60 * 1000;
const MAX_STALE_MS = 30 * 60 * 1000;
let memoryCache = null;

function getRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
  });
}

function normalizeCache(value) {
  if (!value) return null;
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || !parsed.payload || !Number.isFinite(Number(parsed.savedAt))) return null;
  return { payload: parsed.payload, savedAt: Number(parsed.savedAt) };
}

async function readCache(redis) {
  if (redis) {
    try {
      const value = normalizeCache(await redis.get(CACHE_KEY));
      if (value) {
        memoryCache = value;
        return value;
      }
    } catch (error) {
      console.warn("DAGBO USD/NGN cache read failed:", error.message);
    }
  }
  return memoryCache;
}

async function writeCache(redis, value) {
  memoryCache = value;
  if (redis) {
    try {
      await redis.set(CACHE_KEY, JSON.stringify(value), { ex: 30 * 60 });
    } catch (error) {
      console.warn("DAGBO USD/NGN cache write failed:", error.message);
    }
  }
}

function sendCached(res, cached, stale) {
  return res.status(200).json({
    ...cached.payload,
    cached: true,
    ...(stale ? { stale: true } : {})
  });
}

module.exports = async function(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");

  const now = Date.now();
  let redis = null;
  try {
    redis = getRedis();
  } catch (error) {
    console.error("DAGBO USD/NGN Redis setup failed:", error.message);
  }

  const cached = await readCache(redis);
  const cacheAge = cached ? now - cached.savedAt : Infinity;
  if (cached && cacheAge <= FRESH_MS) return sendCached(res, cached, false);

  const key = process.env.TWELVE_DATA_API_KEY || process.env.NEWS_SPIKE_TWELVE_DATA_API_KEY;
  if (!key) {
    if (cached && cacheAge <= MAX_STALE_MS) return sendCached(res, cached, true);
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "Live FX rate unavailable: Twelve Data API key is not configured" });
  }

  try {
    // This endpoint shares the same account-wide 7-request/minute Redis quota
    // as candles, quotes, the scanner and news monitor.
    if (!redis) throw new Error("Shared Twelve Data quota store is unavailable");
    const allowed = await claimTwelveDataSlot(redis);
    if (!allowed) {
      if (cached && cacheAge <= MAX_STALE_MS) return sendCached(res, cached, true);
      throw new Error("Shared Twelve Data minute quota is busy");
    }

    const url = "https://api.twelvedata.com/exchange_rate?symbol=USD%2FNGN&dp=6&apikey=" + encodeURIComponent(key);
    const response = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    const data = await response.json();
    const rate = Number(data && data.rate);
    if (!response.ok || data.status === "error" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(data && data.message ? data.message : "No valid USD/NGN rate returned");
    }

    const timestamp = Number(data.timestamp) || Math.floor(now / 1000);
    const payload = {
      base: "USD",
      quote: "NGN",
      usdNgn: rate,
      timestamp,
      updatedAt: new Date(timestamp * 1000).toISOString(),
      provider: "Twelve Data"
    };
    await writeCache(redis, { savedAt: now, payload });
    return res.status(200).json(payload);
  } catch (error) {
    console.error("DAGBO live USD/NGN lookup failed:", error.message);
    if (cached && cacheAge <= MAX_STALE_MS) return sendCached(res, cached, true);
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "Live USD/NGN rate is temporarily unavailable" });
  }
};

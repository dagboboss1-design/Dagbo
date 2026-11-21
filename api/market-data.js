const SYMBOLS = {
  XAUUSD: "XAU/USD", GOLD: "XAU/USD", XAGUSD: "XAG/USD", SILVER: "XAG/USD",
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY", GBPJPY: "GBP/JPY",
  AUDUSD: "AUD/USD", USDCHF: "USD/CHF", USDCAD: "USD/CAD", NZDUSD: "NZD/USD",
  EURJPY: "EUR/JPY", EURGBP: "EUR/GBP",
  US30: "DJI", US100: "NDX", NAS100: "NDX", US500: "SPX"
};

const BINANCE_SYMBOLS = {
  BTC: "BTCUSDT", BTCUSD: "BTCUSDT", BTCUSDT: "BTCUSDT",
  ETH: "ETHUSDT", ETHUSD: "ETHUSDT", ETHUSDT: "ETHUSDT"
};

const memoryCache = new Map();
let memoryMinute = { startedAt: 0, count: 0 };
const CACHE_SECONDS = 110;
const MAX_TWELVE_CALLS_PER_MINUTE = 6;

function redisClient() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  const { Redis } = require("@upstash/redis");
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

async function readCache(key) {
  try {
    const redis = redisClient();
    if (redis) {
      const value = await redis.get(key);
      if (value) return typeof value === "string" ? JSON.parse(value) : value;
    }
  } catch (error) { console.error("DAGBO market cache read:", error.message); }
  return memoryCache.get(key) || null;
}

async function writeCache(key, value) {
  memoryCache.set(key, value);
  try {
    const redis = redisClient();
    if (redis) await redis.set(key, JSON.stringify(value), { ex: 600 });
  } catch (error) { console.error("DAGBO market cache write:", error.message); }
}

async function claimTwelveDataSlot() {
  try {
    const redis = redisClient();
    if (redis) {
      const count = await redis.incr("dagbo:market:twelve:minute");
      if (count === 1) await redis.expire("dagbo:market:twelve:minute", 60);
      return count <= MAX_TWELVE_CALLS_PER_MINUTE;
    }
  } catch (error) { console.error("DAGBO market rate limiter:", error.message); }
  const now = Date.now();
  if (now - memoryMinute.startedAt >= 60000) memoryMinute = { startedAt: now, count: 0 };
  memoryMinute.count += 1;
  return memoryMinute.count <= MAX_TWELVE_CALLS_PER_MINUTE;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const rawPair = String(req.query && req.query.pair || "").toUpperCase().trim();
  const pair = rawPair.replace(/[^A-Z0-9]/g, "");
  const tf = String(req.query && req.query.tf || "15");
  const intervals = {
    "5": { twelve: "5min", binance: "5m", ms: 5 * 60 * 1000 },
    "15": { twelve: "15min", binance: "15m", ms: 15 * 60 * 1000 },
    "30": { twelve: "30min", binance: "30m", ms: 30 * 60 * 1000 },
    "60": { twelve: "1h", binance: "1h", ms: 60 * 60 * 1000 },
    "240": { twelve: "4h", binance: "4h", ms: 4 * 60 * 60 * 1000 },
    "1day": { twelve: "1day", binance: "1d", ms: 24 * 60 * 60 * 1000 },
    "1week": { twelve: "1week", binance: "1w", ms: 7 * 24 * 60 * 60 * 1000 }
  };
  const interval = intervals[tf];
  if (!interval) return res.status(400).json({ error: "Unsupported timeframe. Use 5, 15, 30, 60, 240, 1day or 1week." });

  // Crypto is served directly from Binance's free, unauthenticated public market-data API.
  // This keeps BTC/ETH requests completely outside the Twelve Data credit quota.
  const binanceSymbol = BINANCE_SYMBOLS[pair];
  if (binanceSymbol) {
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    try {
      const url = "https://data-api.binance.vision/api/v3/klines?symbol=" +
        encodeURIComponent(binanceSymbol) + "&interval=" + interval.binance + "&limit=100";
      const response = await fetch(url, { headers: { "Accept": "application/json" } });
      const rows = await response.json();
      if (!response.ok || !Array.isArray(rows)) {
        const message = rows && rows.msg ? rows.msg : "Binance did not return market candles";
        return res.status(response.status >= 400 && response.status < 500 ? response.status : 502)
          .json({ error: message, provider: "Binance" });
      }
      // Binance returns oldest-first; DAGBO's Twelve Data consumers expect newest-first.
      const values = rows.map(function(row) {
        return {
          datetime: new Date(Number(row[0])).toISOString().slice(0, 19).replace("T", " "),
          open: String(row[1]), high: String(row[2]), low: String(row[3]),
          close: String(row[4]), volume: String(row[5])
        };
      }).reverse();
      if (values.length < 30) {
        return res.status(502).json({ error: "Binance returned fewer than 30 candles.", provider: "Binance" });
      }
      return res.status(200).json({
        pair: pair, symbol: binanceSymbol, timeframe: tf,
        provider: "Binance Spot · Public Market Data",
        providerExchange: "Binance", values: values
      });
    } catch (error) {
      console.error("DAGBO Binance market data error:", error.message);
      return res.status(502).json({ error: "Could not retrieve Binance market candles. Please retry shortly.", provider: "Binance" });
    }
  }

  const symbol = SYMBOLS[pair];
  if (!symbol) return res.status(400).json({ error: "Unsupported market pair" });

  const apiKeys = Array.from(new Set([
    process.env.TWELVE_DATA_API_KEY,
    process.env.TWELVE_DATA_API_KEY_2,
    process.env.TWELVE_DATA_API_KEY_3,
    process.env.NEWS_SPIKE_TWELVE_DATA_API_KEY,
    process.env.SPIKE_TWELVE_DATA_API_KEY
  ].map(value => String(value || "").trim()).filter(Boolean)));
  if (!apiKeys.length) return res.status(503).json({ error: "Market data is not configured. Add a Twelve Data API key in Vercel." });

  const cacheKey = "dagbo:market:candles:" + pair + ":" + tf;
  const cached = await readCache(cacheKey);
  const cacheAge = cached ? Date.now() - Number(cached.savedAt || 0) : Infinity;
  if (cached && cacheAge <= CACHE_SECONDS * 1000) {
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return res.status(200).json({ ...cached.payload, cache: "hit", cachedAt: new Date(cached.savedAt).toISOString() });
  }

  const allowed = await claimTwelveDataSlot();
  if (!allowed) {
    if (cached && cacheAge <= 10 * 60 * 1000) {
      return res.status(200).json({ ...cached.payload, cache: "stale-fallback", stale: true, cacheAgeSeconds: Math.round(cacheAge / 1000) });
    }
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "DAGBO is protecting the Twelve Data quota. The shared limit of 6 requests per minute has been reached; retry shortly.", provider: "DAGBO rate limiter", retryAfter: 60 });
  }

  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  try {
    let data = null, lastProviderError = "Twelve Data did not return candles";
    for (const apiKey of apiKeys) {
      try {
        const url = "https://api.twelvedata.com/time_series?symbol=" +
          encodeURIComponent(symbol) +
          "&interval=" + interval.twelve + "&outputsize=100&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
        const response = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "Accept": "application/json" } });
        const body = await response.json();
        if (response.ok && body.status !== "error" && Array.isArray(body.values) && body.values.length >= 30) {
          data = body;
          break;
        }
        lastProviderError = body.message || "Twelve Data returned invalid candle data";
        if (response.status !== 429 && !/credits|rate limit|api calls|invalid api|api key/i.test(lastProviderError)) {
          // A symbol/plan/data error is unlikely to be repaired by another key.
          break;
        }
      } catch (providerError) {
        lastProviderError = providerError && providerError.message ? providerError.message : "Twelve Data request failed";
      }
    }
    if (!data) {
      if (cached && cacheAge <= 10 * 60 * 1000) {
        return res.status(200).json({ ...cached.payload, cache: "stale-fallback", stale: true,
          cacheAgeSeconds: Math.round(cacheAge / 1000), providerWarning: lastProviderError });
      }
      return res.status(/rate limit|credits|api calls/i.test(lastProviderError) ? 429 : 502)
        .json({ error: lastProviderError, provider: "Twelve Data / configured backup keys" });
    }

    const payload = {
      pair, timeframe: tf, provider: "Twelve Data",
      providerExchange: data.meta && data.meta.exchange ? data.meta.exchange : null,
      values: data.values
    };
    await writeCache(cacheKey, { savedAt: Date.now(), payload });
    return res.status(200).json({ ...payload, cache: "miss" });
  } catch (error) {
    console.error("DAGBO market data proxy error:", error.message);
    if (cached && cacheAge <= 10 * 60 * 1000) {
      return res.status(200).json({ ...cached.payload, cache: "stale-fallback", stale: true,
        cacheAgeSeconds: Math.round(cacheAge / 1000), providerWarning: "Live provider temporarily unavailable" });
    }
    return res.status(502).json({ error: "Could not retrieve market candles", provider: "Twelve Data" });
  }
};

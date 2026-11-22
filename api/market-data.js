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

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 9000);
  try {
    const response = await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
    const data = await response.json();
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

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


function fcsPeriod(tf) {
  return ({ "5":"5m", "15":"15m", "30":"30m", "60":"1h", "240":"4h", "1day":"1D", "1week":"1W" })[tf] || null;
}
function normalizeFcsCandles(data) {
  const source = data && data.response;
  const rows = Array.isArray(source) ? source : (source && typeof source === "object" ? Object.values(source) : []);
  return rows.map(function(row) {
    const rawTime = row.tm || row.datetime || row.date || row.time;
    const numericTime = Number(row.t || row.timestamp || rawTime);
    const date = Number.isFinite(numericTime) && numericTime > 1000000000
      ? new Date(numericTime * (numericTime < 100000000000 ? 1000 : 1))
      : new Date(String(rawTime || ""));
    if (!Number.isFinite(date.getTime())) return null;
    const open = Number(row.o ?? row.open), high = Number(row.h ?? row.high);
    const low = Number(row.l ?? row.low), close = Number(row.c ?? row.close);
    if (![open,high,low,close].every(Number.isFinite) || open<=0 || high<=0 || low<=0 || close<=0 || high<low) return null;
    return { datetime: date.toISOString().slice(0,19).replace("T"," "), open:String(open), high:String(high), low:String(low), close:String(close), volume:String(row.v ?? row.volume ?? 0) };
  }).filter(Boolean).sort((a,b)=>Date.parse(a.datetime)-Date.parse(b.datetime));
}
async function fetchFcsFallback(pair, tf) {
  const key = process.env.FCS_API_KEY;
  const period = fcsPeriod(tf);
  if (!key || !period) return null;
  const fxPairs = ["EURUSD","GBPUSD","USDJPY","GBPJPY","AUDUSD","USDCHF","USDCAD","NZDUSD","EURJPY","EURGBP"];
  const commodities = ["XAUUSD","GOLD","XAGUSD","SILVER"];
  if (!fxPairs.includes(pair) && !commodities.includes(pair)) return null;
  const symbol = pair === "GOLD" ? "XAUUSD" : (pair === "XAGUSD" ? "SILVER" : pair);
  const type = commodities.includes(pair) ? "&type=commodity" : "";
  const url = "https://api-v4.fcsapi.com/forex/history?symbol=" + encodeURIComponent(symbol) +
    "&period=" + encodeURIComponent(period) + "&length=100&is_chart=0" + type +
    "&access_key=" + encodeURIComponent(key);
  const result = await fetchJsonWithTimeout(url, { headers: { "Accept":"application/json" } }, 9000);
  if (!result.response.ok || result.data.status === false || Number(result.data.code) !== 200) {
    throw new Error("FCS rejected the candle request: " + String(result.data.msg || result.response.status));
  }
  const values = normalizeFcsCandles(result.data);
  if (values.length < 30) throw new Error("FCS returned fewer than 30 valid candles.");
  return { pair, timeframe:tf, provider:"FCS", providerExchange:"FCS", values };
}
async function fetchFmpFallback(pair, tf) {
  const key = process.env.FMP_API_KEY;
  const fmpPeriods = { "5":"5min", "15":"15min", "30":"30min", "60":"1hour" };
  const period = fmpPeriods[tf];
  const fxPairs = ["EURUSD","GBPUSD","USDJPY","GBPJPY","AUDUSD","USDCHF","USDCAD","NZDUSD","EURJPY","EURGBP"];
  if (!key || !period || !fxPairs.includes(pair)) return null;
  const lookbackDays = tf === "5" ? 10 : (tf === "15" ? 25 : 60);
  const from = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0,10);
  const url = "https://financialmodelingprep.com/stable/historical-chart/" + period +
    "?symbol=" + encodeURIComponent(pair) + "&from=" + from + "&apikey=" + encodeURIComponent(key);
  const result = await fetchJsonWithTimeout(url, { headers: { "Accept":"application/json" } }, 9000);
  if (!result.response.ok || !Array.isArray(result.data)) {
    const message = result.data && (result.data.message || result.data.error) || result.response.status;
    throw new Error("FMP rejected the candle request: " + String(message));
  }
  const values = result.data.map(function(row) {
    const date = new Date(String(row.date || row.datetime || ""));
    const open=Number(row.open), high=Number(row.high), low=Number(row.low), close=Number(row.close);
    if (!Number.isFinite(date.getTime()) || ![open,high,low,close].every(Number.isFinite) || open<=0 || high<=0 || low<=0 || close<=0 || high<low) return null;
    return { datetime:date.toISOString().slice(0,19).replace("T"," "), open:String(open), high:String(high), low:String(low), close:String(close), volume:String(row.volume || 0) };
  }).filter(Boolean).sort((a,b)=>Date.parse(a.datetime)-Date.parse(b.datetime));
  if (values.length < 30) throw new Error("FMP returned fewer than 30 valid candles.");
  return { pair, timeframe:tf, provider:"Financial Modeling Prep", providerExchange:"FMP", values };
}
async function fetchBackupCandles(pair, tf) {
  const failures = [];
  for (const provider of [fetchFcsFallback, fetchFmpFallback]) {
    try {
      const payload = await provider(pair, tf);
      if (payload) return { payload, failures };
    } catch (error) {
      failures.push(error.message || String(error));
      console.error("DAGBO market backup error:", error.message);
    }
  }
  return { payload:null, failures };
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
      const result = await fetchJsonWithTimeout(url, { headers: { "Accept": "application/json" } }, 9000);
      const response = result.response;
      const rows = result.data;
      if (!response.ok || !Array.isArray(rows)) {
        const message = rows && rows.msg ? rows.msg : "Binance did not return market candles";
        return res.status(response.status >= 400 && response.status < 500 ? response.status : 502)
          .json({ error: message, provider: "Binance" });
      }
      const values = rows.map(function(row) {
        return {
          datetime: new Date(Number(row[0])).toISOString().slice(0, 19).replace("T", " "),
          open: String(row[1]), high: String(row[2]), low: String(row[3]),
          close: String(row[4]), volume: String(row[5])
        };
      });
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
      const timedOut = error && error.name === "AbortError";
      return res.status(timedOut ? 504 : 502).json({ error: timedOut ? "Binance market-data request timed out. Retry shortly." : "Could not retrieve Binance market candles. Please retry shortly.", provider: "Binance", errorCode: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR" });
    }
  }

  const symbol = SYMBOLS[pair];
  if (!symbol) return res.status(400).json({ error: "Unsupported market pair" });


  const cacheKey = "dagbo:market:candles:" + pair + ":" + tf;
  const cached = await readCache(cacheKey);
  const cacheAge = cached ? Date.now() - Number(cached.savedAt || 0) : Infinity;
  if (cached && cacheAge <= CACHE_SECONDS * 1000) {
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return res.status(200).json({ ...cached.payload, cache: "hit", cachedAt: new Date(cached.savedAt).toISOString() });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  let primaryFailure = null;
  if (apiKey) {
    const allowed = await claimTwelveDataSlot();
    if (allowed) {
      try {
        const url = "https://api.twelvedata.com/time_series?symbol=" +
          encodeURIComponent(symbol) + "&interval=" + interval.twelve +
          "&outputsize=100&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
        const result = await fetchJsonWithTimeout(url, {}, 9000);
        const data = result.data;
        if (!result.response.ok || data.status === "error" || !Array.isArray(data.values)) {
          primaryFailure = data.message || "Twelve Data returned no candle data";
        } else if (data.values.length < 30) {
          primaryFailure = "Twelve Data returned fewer than 30 candles";
        } else {
          const payload = {
            pair, timeframe:tf, provider:"Twelve Data",
            providerExchange:data.meta && data.meta.exchange ? data.meta.exchange : null,
            values:data.values
          };
          await writeCache(cacheKey, { savedAt:Date.now(), payload });
          res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
          return res.status(200).json({ ...payload, cache:"miss" });
        }
      } catch (error) {
        primaryFailure = error.message || "Twelve Data request failed";
      }
    } else {
      primaryFailure = "Twelve Data request quota is busy";
    }
  } else {
    primaryFailure = "TWELVE_DATA_API_KEY is not configured";
  }

  // Provider failover: Twelve Data -> FCS -> FMP (where supported).
  const backup = await fetchBackupCandles(pair, tf);
  if (backup.payload) {
    const payload = backup.payload;
    await writeCache(cacheKey, { savedAt:Date.now(), payload });
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=20");
    return res.status(200).json({
      ...payload, cache:"backup", failover:true,
      primaryProvider:"Twelve Data",
      primaryError:primaryFailure
    });
  }

  // Stale candles are never silently treated as live data; the Signals page
  // explicitly rejects data.stale and will not calculate an executable setup.
  if (cached && cacheAge <= 10 * 60 * 1000) {
    return res.status(200).json({
      ...cached.payload, cache:"stale-fallback", stale:true,
      cacheAgeSeconds:Math.round(cacheAge/1000),
      failover:true,
      error:"Live providers unavailable. Cached candles are too old for a fresh signal."
    });
  }

  return res.status(503).json({
    error:"DATA UNAVAILABLE · No live market provider returned valid candles. No signal should be generated.",
    provider:"DAGBO failover manager",
    primaryError:primaryFailure,
    backupErrors:backup.failures
  });

};

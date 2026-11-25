const SYMBOLS = {
  XAUUSD: "XAU/USD", GOLD: "XAU/USD", XAGUSD: "XAG/USD", SILVER: "XAG/USD",
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY", GBPJPY: "GBP/JPY",
  AUDUSD: "AUD/USD", USDCHF: "USD/CHF", USDCAD: "USD/CAD", NZDUSD: "NZD/USD",
  EURJPY: "EUR/JPY", EURGBP: "EUR/GBP", USDSEK: "USD/SEK", DXY: "DXY"
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
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; }
    catch (_) { data = { message: String(raw || "Non-JSON provider response").slice(0, 240) }; }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

const memoryCache = new Map();
let memoryMinute = { startedAt: 0, count: 0 };
const CACHE_SECONDS = 110;
const MAX_TWELVE_CALLS_PER_MINUTE = 7;

function redisClient() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  const { Redis } = require("@upstash/redis");
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error((label || 'Market cache') + ' timed out')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readCache(key) {
  try {
    const redis = redisClient();
    if (redis) {
      const value = await withTimeout(redis.get(key), 1200, 'Market cache read');
      if (value) return typeof value === "string" ? JSON.parse(value) : value;
    }
  } catch (error) { console.error("DAGBO market cache read:", error.message); }
  return memoryCache.get(key) || null;
}

async function writeCache(key, value) {
  memoryCache.set(key, value);
  try {
    const redis = redisClient();
    if (redis) await withTimeout(redis.set(key, JSON.stringify(value), { ex: 600 }), 1200, 'Market cache write');
  } catch (error) { console.error("DAGBO market cache write:", error.message); }
}

async function claimTwelveDataSlot() {
  try {
    const redis = redisClient();
    if (redis) {
      const count = await withTimeout(redis.incr('dagbo:market:twelve:minute'), 1200, 'Market quota check');
      if (count === 1) await withTimeout(redis.expire('dagbo:market:twelve:minute', 60), 1200, 'Market quota expiry');
      return count <= MAX_TWELVE_CALLS_PER_MINUTE;
    }
  } catch (error) { console.error("DAGBO market rate limiter:", error.message); }
  const now = Date.now();
  if (now - memoryMinute.startedAt >= 60000) memoryMinute = { startedAt: now, count: 0 };
  memoryMinute.count += 1;
  return memoryMinute.count <= MAX_TWELVE_CALLS_PER_MINUTE;
}


function fcsPeriod(tf) {
  return ({ "1":"1m", "5":"5m", "15":"15m", "30":"30m", "60":"1h", "240":"4h", "1day":"1D", "1week":"1W" })[tf] || null;
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
    if (![open,high,low,close].every(Number.isFinite) || open<=0 || high<=0 || low<=0 || close<=0 ||
        high<low || high<Math.max(open,close) || low>Math.min(open,close)) return null;
    return { datetime: date.toISOString().slice(0,19).replace("T"," "), open:String(open), high:String(high), low:String(low), close:String(close), volume:String(row.v ?? row.volume ?? 0) };
  }).filter(Boolean).sort((a,b)=>Date.parse(a.datetime)-Date.parse(b.datetime));
}
async function fetchFcsFallback(pair, tf) {
  const key = process.env.FCS_API_KEY || process.env.FCS_ACCESS_KEY || process.env.FCS_API_ACCESS_KEY || process.env.FCSAPI_ACCESS_KEY;
  const period = fcsPeriod(tf);
  if (!key || !period) return null;
  const fxPairs = ["EURUSD","GBPUSD","USDJPY","GBPJPY","AUDUSD","USDCHF","USDCAD","NZDUSD","EURJPY","EURGBP","USDSEK"];
  const commodities = ["XAUUSD","GOLD","XAGUSD","SILVER"];
  if (!fxPairs.includes(pair) && !commodities.includes(pair)) return null;
  const symbol = pair === "GOLD" ? "XAUUSD" : (pair === "XAGUSD" ? "SILVER" : pair);
  const type = commodities.includes(pair) ? "&type=commodity" : "";
  const url = "https://api-v4.fcsapi.com/forex/history?symbol=" + encodeURIComponent(symbol) +
    "&period=" + encodeURIComponent(period) + "&length=150&is_chart=0" + type +
    "&access_key=" + encodeURIComponent(key);
  const result = await fetchJsonWithTimeout(url, { headers: { "Accept":"application/json" } }, 3500);
  if (!result.response.ok || result.data.status === false || result.data.status === "error" ||
      (result.data.code !== undefined && Number(result.data.code) !== 200)) {
    throw new Error("FCS rejected the candle request: " + String(result.data.msg || result.response.status));
  }
  const values = normalizeFcsCandles(result.data);
  if (values.length < 30) throw new Error("FCS returned fewer than 30 valid candles.");
  return { pair, timeframe:tf, provider:"FCS", providerExchange:"FCS", values };
}
async function fetchBackupCandles(pair, tf) {
  const failures = [];
  const authBlock = await readCache("dagbo:market:fcs-auth-blocked");
  if (authBlock && Number(authBlock.until) > Date.now()) {
    return { payload:null, failures:["FCS access key was rejected recently; verify the FCS credential and Vercel environment before failover can resume."] };
  }
  for (const provider of [fetchFcsFallback]) {
    try {
      const payload = await provider(pair, tf);
      if (payload) return { payload, failures };
    } catch (error) {
      const message = error.message || String(error);
      failures.push(message);
      if (/valid API Access Key|invalid api access key/i.test(message)) {
        await writeCache("dagbo:market:fcs-auth-blocked", { until: Date.now() + 10 * 60 * 1000 });
      }
      console.error("DAGBO market backup error:", message);
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
    "1": { twelve: "1min", binance: "1m", ms: 60 * 1000 },
    "5": { twelve: "5min", binance: "5m", ms: 5 * 60 * 1000 },
    "15": { twelve: "15min", binance: "15m", ms: 15 * 60 * 1000 },
    "30": { twelve: "30min", binance: "30m", ms: 30 * 60 * 1000 },
    "60": { twelve: "1h", binance: "1h", ms: 60 * 60 * 1000 },
    "240": { twelve: "4h", binance: "4h", ms: 4 * 60 * 60 * 1000 },
    "1day": { twelve: "1day", binance: "1d", ms: 24 * 60 * 60 * 1000 },
    "1week": { twelve: "1week", binance: "1w", ms: 7 * 24 * 60 * 60 * 1000 }
  };
  const interval = intervals[tf];
  if (!interval) return res.status(400).json({ error: "Unsupported timeframe. Use 1, 5, 15, 30, 60, 240, 1day or 1week." });

  // Exact index CFD quotes are not currently connected. Never substitute ETF prices.
  if (["US30","US100","NAS100","US500"].includes(pair)) {
    return res.status(503).json({
      error: "DIRECT INDEX DATA UNAVAILABLE · ETF proxy prices are not valid substitutes for this index. No signal price can be issued.",
      pair, marketDataType: "UNAVAILABLE"
    });
  }

  // A live quote is requested only for a confirmed setup, keeping quote calls
  // out of routine WAIT scans and avoiding candle-close prices being labelled live.
  if (String(req.query && req.query.quote || "") === "1") {
    try {
      const cryptoSymbol = BINANCE_SYMBOLS[pair];
      if (cryptoSymbol) {
        const url = "https://data-api.binance.vision/api/v3/ticker/price?symbol=" + encodeURIComponent(cryptoSymbol);
        const result = await fetchJsonWithTimeout(url, { headers: { "Accept":"application/json" } }, 7000);
        const price = Number(result.data && result.data.price);
        if (!result.response.ok || !Number.isFinite(price) || price <= 0) throw new Error("Binance returned no valid live quote");
        return res.status(200).json({ pair, symbol: cryptoSymbol, price, provider:"Binance Spot · Live Quote", quoteTime:new Date().toISOString(), marketDataType:"DIRECT" });
      }
      const symbol = SYMBOLS[pair];
      if (!symbol) return res.status(400).json({ error:"Unsupported market pair" });
      const apiKey = process.env.TWELVE_DATA_API_KEY || process.env.NEWS_SPIKE_TWELVE_DATA_API_KEY;
      if (!apiKey) throw new Error("Twelve Data live quote key is not configured");
      const allowed = await claimTwelveDataSlot();
      if (!allowed) throw new Error("Twelve Data quote quota is busy; retry on the next scan");
      const url = "https://api.twelvedata.com/price?symbol=" + encodeURIComponent(symbol) + "&apikey=" + encodeURIComponent(apiKey);
      const result = await fetchJsonWithTimeout(url, {}, 7000);
      const price = Number(result.data && result.data.price);
      if (!result.response.ok || result.data.status === "error" || !Number.isFinite(price) || price <= 0) {
        throw new Error(result.data && result.data.message || "Twelve Data returned no valid live quote");
      }
      return res.status(200).json({ pair, symbol, price, provider:"Twelve Data · Live Quote", quoteTime:new Date().toISOString(), marketDataType:"DIRECT" });
    } catch (error) {
      return res.status(503).json({ error:"LIVE QUOTE UNAVAILABLE · " + String(error.message || error), pair, marketDataType:"UNAVAILABLE" });
    }
  }

  // Crypto is served directly from Binance's free, unauthenticated public market-data API.
  // This keeps BTC/ETH requests completely outside the Twelve Data credit quota.
  const binanceSymbol = BINANCE_SYMBOLS[pair];
  if (binanceSymbol) {
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    try {
      const url = "https://data-api.binance.vision/api/v3/klines?symbol=" +
        encodeURIComponent(binanceSymbol) + "&interval=" + interval.binance + "&limit=150";
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
  const cacheKey = "dagbo:market:candles:v2:" + pair + ":" + tf;
  const cached = await readCache(cacheKey);
  const cacheAge = cached ? Date.now() - Number(cached.savedAt || 0) : Infinity;
  if (cached && cacheAge <= CACHE_SECONDS * 1000) {
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return res.status(200).json({ ...cached.payload, cache: "hit", cachedAt: new Date(cached.savedAt).toISOString() });
  }

  // The normal key is the primary credential. If it is not configured in
  // Vercel, use the already-configured dedicated Twelve Data key as a safe
  // temporary fallback so the scanner does not fail with an empty primary key.
  // Both requests still share the same global credit limiter.
  const apiKey = process.env.TWELVE_DATA_API_KEY || process.env.NEWS_SPIKE_TWELVE_DATA_API_KEY;
  const primaryKeySource = process.env.TWELVE_DATA_API_KEY ? "TWELVE_DATA_API_KEY" :
    (process.env.NEWS_SPIKE_TWELVE_DATA_API_KEY ? "NEWS_SPIKE_TWELVE_DATA_API_KEY_FALLBACK" : "MISSING");
  let primaryFailure = null;
  if (apiKey) {
    const allowed = await claimTwelveDataSlot();
    if (allowed) {
      try {
        const url = "https://api.twelvedata.com/time_series?symbol=" +
          encodeURIComponent(symbol) + "&interval=" + interval.twelve +
          "&outputsize=150&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
        const result = await fetchJsonWithTimeout(url, {}, 9000);
        const data = result.data;
        if (!result.response.ok || data.status === "error" || !Array.isArray(data.values)) {
          primaryFailure = data.message || "Twelve Data returned no candle data";
        } else if (data.values.length < 30) {
          primaryFailure = "Twelve Data returned fewer than 30 candles";
        } else {
          const payload = {
            pair, timeframe:tf, provider:"Twelve Data",
            providerKeySource:primaryKeySource,
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

  console.error("DAGBO Twelve Data primary failed for " + pair + " (" + tf + ") using " + primaryKeySource + ": " + String(primaryFailure || "unknown provider failure").slice(0, 240));
  // Provider failover: Twelve Data -> FCS only. No third-party candle fallback is permitted.
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

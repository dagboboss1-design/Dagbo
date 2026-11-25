'use strict';

const marketDataHandler = require("./market-data");

const INDEX_PAIRS = new Set(["US30", "US100", "NAS100", "US500"]);
const INTERVALS = { "5": "5", "15": "15", "60": "60", "240": "240", "D": "1day" };

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const pair = String(req.query && req.query.pair || "XAUUSD").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const interval = String(req.query && req.query.interval || "15");
  const timeframe = INTERVALS[interval];

  if (INDEX_PAIRS.has(pair)) {
    return res.status(503).json({
      error: "DIRECT INDEX DATA UNAVAILABLE · No exact index CFD feed is connected. ETF proxy prices are not valid substitutes.",
      pair,
      marketDataType: "UNAVAILABLE"
    });
  }
  if (!timeframe) return res.status(400).json({ error: "Unsupported market or timeframe" });

  // Route charts through the same provider manager as Signals and scheduled scans.
  // This guarantees identical Twelve Data -> FCS failover, validation, cache and
  // stale-data rules instead of maintaining a second, weaker provider path.
  const marketResponse = responseStub();
  await marketDataHandler({
    method: "GET",
    query: { pair, tf: timeframe }
  }, marketResponse);

  if (marketResponse.statusCode < 200 || marketResponse.statusCode >= 300) {
    return res.status(marketResponse.statusCode).json({
      ...marketResponse.body,
      pair,
      interval,
      marketDataType: "UNAVAILABLE"
    });
  }

  const payload = marketResponse.body || {};
  if (!Array.isArray(payload.values) || payload.values.length < 30) {
    return res.status(502).json({
      error: "Market provider returned insufficient validated chart candles.",
      pair,
      interval,
      marketDataType: "UNAVAILABLE"
    });
  }

  const candles = payload.values.map(candle => ({
    time: Math.floor(Date.parse(candle.datetime.replace(" ", "T") + "Z") / 1000),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume || 0)
  }));

  if (candles.some(candle => !Number.isFinite(candle.time) ||
      ![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))) {
    return res.status(502).json({
      error: "Validated market candles could not be converted for chart display.",
      pair,
      interval,
      marketDataType: "UNAVAILABLE"
    });
  }

  return res.status(200).json({
    pair,
    interval,
    candles,
    source: payload.provider || "DAGBO market-data manager",
    sourceSymbol: payload.symbol || payload.pair,
    providerExchange: payload.providerExchange || null,
    providerKeySource: payload.providerKeySource || null,
    failover: !!payload.failover || payload.provider === "FCS",
    primaryProvider: payload.primaryProvider || null,
    primaryError: payload.primaryError || null,
    stale: !!payload.stale,
    cache: payload.cache || null,
    marketDataType: payload.marketDataType || "DIRECT",
    timezone: "UTC",
    updatedAt: payload.fetchedAt || payload.updatedAt || new Date().toISOString()
  });
};

'use strict';
const SYMBOLS = {
  XAUUSD: "XAU/USD", EURUSD: "EUR/USD", GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY", GBPJPY: "GBP/JPY", AUDUSD: "AUD/USD",
  USDCHF: "USD/CHF", USDCAD: "USD/CAD", NZDUSD: "NZD/USD",
  EURJPY: "EUR/JPY", EURGBP: "EUR/GBP", BTCUSD: "BTC/USD",
  ETHUSD: "ETH/USD", US30: "DJI", US100: "NDX", US500: "SPX"
};
const INTERVALS = { "5":"5min", "15":"15min", "60":"1h", "240":"4h", "D":"1day" };
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const pair = String(req.query.pair || "XAUUSD").toUpperCase();
  const interval = String(req.query.interval || "15");
  const start = String(req.query.start || "");
  const end = String(req.query.end || "");
  if (!SYMBOLS[pair]) return res.status(400).json({ error: "Unsupported replay market" });
  if (!INTERVALS[interval]) return res.status(400).json({ error: "Unsupported timeframe" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    return res.status(400).json({ error: "Choose a valid start and end date" });
  const from = Date.parse(start + "T00:00:00Z"), to = Date.parse(end + "T23:59:59Z");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to > Date.now() + 86400000)
    return res.status(400).json({ error: "Invalid date range" });
  if (to - from > 31 * 86400000) return res.status(400).json({ error: "Choose a range of 31 days or less" });
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return res.status(503).json({ error: "Historical data is not configured on the server" });
  const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(SYMBOLS[pair]) +
    "&interval=" + encodeURIComponent(INTERVALS[interval]) + "&start_date=" + encodeURIComponent(start) +
    "&end_date=" + encodeURIComponent(end) + "&timezone=UTC&outputsize=5000&apikey=" + encodeURIComponent(key);
  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    if (!upstream.ok || data.status === "error" || !Array.isArray(data.values))
      return res.status(502).json({ error: data.message || "Historical candles are unavailable for this market and date range" });
    const candles = data.values.map(c => ({
      time: c.datetime, open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close), volume: Number(c.volume || 0)
    })).filter(c => [c.open,c.high,c.low,c.close].every(Number.isFinite))
      .sort((a,b) => a.time.localeCompare(b.time));
    return res.status(200).json({ pair, interval, candles, source: "Twelve Data", timezone: "UTC" });
  } catch (e) {
    return res.status(502).json({ error: "Could not retrieve historical candles" });
  }
};

const SYMBOLS = {
  XAUUSD: "XAU/USD", GOLD: "XAU/USD",
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY", GBPJPY: "GBP/JPY",
  AUDUSD: "AUD/USD", USDCHF: "USD/CHF", USDCAD: "USD/CAD", NZDUSD: "NZD/USD",
  EURJPY: "EUR/JPY", EURGBP: "EUR/GBP",
  US30: "DJI", US100: "NDX", NAS100: "NDX", US500: "SPX",
  BTCUSD: "BTC/USD", BTC: "BTC/USD", ETHUSD: "ETH/USD", ETH: "ETH/USD"
};


const { SYMBOLS: SPIKE_SYMBOLS, analyze, selectCompletedBefore } = require("../lib/spike-engine");
async function runSpikePredictor(req, res, pair, mode) {
  if (!Object.prototype.hasOwnProperty.call(SPIKE_SYMBOLS, pair)) return res.status(400).json({ error: "Unsupported pair. Check the supported instruments list." });
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Market data is not configured on the server." });
  try {
    if (mode === "live") {
      const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(SPIKE_SYMBOLS[pair]) + "&interval=5min&outputsize=70&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
      const response = await fetch(url), data = await response.json();
      if (!response.ok || data.status === "error" || !Array.isArray(data.values)) return res.status(502).json({ error: data.message || "Market candle provider unavailable." });
      return res.status(200).json(analyze(data.values, pair, "LIVE", null));
    }
    const calendarResponse = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": "DAGBO-SIGNAL-Spike-Predictor/1.0" } });
    if (!calendarResponse.ok) return res.status(502).json({ error: "Economic calendar is temporarily unavailable." });
    const calendar = await calendarResponse.json();
    if (!Array.isArray(calendar)) return res.status(502).json({ error: "Economic calendar returned invalid data." });
    const now = Date.now(), currencies = pair.length === 6 ? [pair.slice(0, 3), pair.slice(3, 6)] : [];
    const upcoming = calendar.map(row => ({ name: String(row.title || "Economic event").slice(0, 120), currency: String(row.country || "").toUpperCase(), impact: String(row.impact || "").toLowerCase(), date: new Date(row.date) }))
      .filter(event => event.impact === "high" && Number.isFinite(event.date.getTime()) && event.date.getTime() >= now + 10 * 60000 && event.date.getTime() <= now + 20 * 60000 && (event.currency === "GLOBAL" || currencies.includes(event.currency))).sort((a, b) => a.date - b.date);
    if (!upcoming.length) return res.status(200).json({ ready: false, pair, mode: "PRE_NEWS", reason: "No matching high-impact event 10–20 minutes away. No pre-news prediction was generated." });
    const event = upcoming[0], cutoff = event.date.getTime() - 15 * 60000;
    const candleUrl = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(SPIKE_SYMBOLS[pair]) + "&interval=15min&outputsize=70&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
    const candleResponse = await fetch(candleUrl), candleData = await candleResponse.json();
    if (!candleResponse.ok || candleData.status === "error" || !Array.isArray(candleData.values)) return res.status(502).json({ error: candleData.message || "Pre-news candles are unavailable." });
    const candles = selectCompletedBefore(candleData.values, cutoff, 15, 12 * 60);
    return res.status(200).json(analyze(candles, pair, "PRE_NEWS", { name: event.name, currency: event.currency, releaseTime: event.date.toISOString(), minutesToRelease: Number(((event.date.getTime() - now) / 60000).toFixed(1)) }));
  } catch (error) {
    console.error("DAGBO spike predictor error:", error.message);
    return res.status(502).json({ error: "Spike analysis could not be completed. Please retry." });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=20");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const pair = String(req.query && req.query.pair || "").toUpperCase();
  const tf = String(req.query && req.query.tf || "15");
  const mode = String(req.query && req.query.mode || "").toLowerCase();
  if (mode === "live" || mode === "pre-news") return runSpikePredictor(req, res, pair, mode);
  const symbol = SYMBOLS[pair];

  if (!symbol) return res.status(400).json({ error: "Unsupported market pair" });
  if (tf !== "5" && tf !== "15") return res.status(400).json({ error: "Timeframe must be 5 or 15 minutes" });

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Market data is not configured. Add TWELVE_DATA_API_KEY in Vercel." });

  try {
    const url = "https://api.twelvedata.com/time_series?symbol=" +
      encodeURIComponent(symbol) + "&interval=" + tf +
      "min&outputsize=60&apikey=" + encodeURIComponent(apiKey);
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
      return res.status(502).json({ error: data.message || "Market data provider did not return candles" });
    }

    return res.status(200).json({ pair, timeframe: tf, values: data.values });
  } catch (error) {
    console.error("DAGBO market data proxy error:", error.message);
    return res.status(502).json({ error: "Could not retrieve market candles" });
  }
};

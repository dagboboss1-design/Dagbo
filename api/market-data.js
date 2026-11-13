const SYMBOLS = {
  XAUUSD: "XAU/USD", GOLD: "XAU/USD",
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY", GBPJPY: "GBP/JPY",
  AUDUSD: "AUD/USD", USDCHF: "USD/CHF", USDCAD: "USD/CAD", NZDUSD: "NZD/USD",
  EURJPY: "EUR/JPY", EURGBP: "EUR/GBP",
  US30: "DJI", US100: "NDX", NAS100: "NDX", US500: "SPX",
  BTCUSD: "BTC/USD", BTC: "BTC/USD", ETHUSD: "ETH/USD", ETH: "ETH/USD"
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=20");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const pair = String(req.query && req.query.pair || "").toUpperCase();
  const tf = String(req.query && req.query.tf || "15");
  const symbol = SYMBOLS[pair];

  if (!symbol) return res.status(400).json({ error: "Unsupported market pair" });
  if (tf !== "5" && tf !== "15") return res.status(400).json({ error: "Timeframe must be 5 or 15 minutes" });

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Market data is not configured. Add TWELVE_DATA_API_KEY in Vercel." });

  try {
    const url = "https://api.twelvedata.com/time_series?symbol=" +
      encodeURIComponent(symbol) + "&interval=" + tf +
      "min&outputsize=60&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
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

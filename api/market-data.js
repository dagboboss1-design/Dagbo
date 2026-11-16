const SYMBOLS = {
  XAUUSD: "XAU/USD", GOLD: "XAU/USD",
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY", GBPJPY: "GBP/JPY",
  AUDUSD: "AUD/USD", USDCHF: "USD/CHF", USDCAD: "USD/CAD", NZDUSD: "NZD/USD",
  EURJPY: "EUR/JPY", EURGBP: "EUR/GBP",
  US30: "DJI", US100: "NDX", NAS100: "NDX", US500: "SPX",
  BTCUSD: "BTC/USD", BTCUSDT: "BTC/USD", BTC: "BTC/USD",
  ETHUSD: "ETH/USD", ETHUSDT: "ETH/USD", ETH: "ETH/USD"
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=20");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const rawPair = String(req.query && req.query.pair || "").toUpperCase().trim();
  const pair = rawPair.replace(/[^A-Z0-9]/g, "");
  const tf = String(req.query && req.query.tf || "15");
  const symbol = SYMBOLS[pair];
  const isCrypto = /^(BTC|BTCUSD|BTCUSDT|ETH|ETHUSD|ETHUSDT)$/.test(pair);

  if (!symbol) return res.status(400).json({ error: "Unsupported market pair" });
  if (tf !== "5" && tf !== "15") return res.status(400).json({ error: "Timeframe must be 5 or 15 minutes" });

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Market data is not configured. Add TWELVE_DATA_API_KEY in Vercel." });

  try {
    const url = "https://api.twelvedata.com/time_series?symbol=" +
      encodeURIComponent(symbol) + (isCrypto ? "&exchange=Binance" : "") +
      "&interval=" + tf + "min&outputsize=100&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
      return res.status(502).json({ error: data.message || "Market data provider did not return candles" });
    }

    if (isCrypto && (!data.meta || !data.meta.exchange || String(data.meta.exchange).trim().toLowerCase() !== "binance")) {
      return res.status(502).json({ error: "Twelve Data did not confirm Binance as the source exchange.", providerExchange: data.meta && data.meta.exchange ? data.meta.exchange : null });
    }

    return res.status(200).json({
      pair, timeframe: tf, provider: isCrypto ? "Twelve Data · Binance" : "Twelve Data",
      providerExchange: data.meta && data.meta.exchange ? data.meta.exchange : (isCrypto ? "Binance (requested)" : null),
      values: data.values
    });
  } catch (error) {
    console.error("DAGBO market data proxy error:", error.message);
    return res.status(502).json({ error: "Could not retrieve market candles" });
  }
};

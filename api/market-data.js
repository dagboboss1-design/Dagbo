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
const COINBASE_PRODUCTS = { BTC: "BTC-USD", BTCUSD: "BTC-USD", BTCUSDT: "BTC-USD", ETH: "ETH-USD", ETHUSD: "ETH-USD", ETHUSDT: "ETH-USD" };

async function coinbaseCandles(pair, tf) {
  const product = COINBASE_PRODUCTS[pair];
  const granularity = Number(tf) * 60;
  const url = "https://api.exchange.coinbase.com/products/" + product + "/candles?granularity=" + granularity;
  const response = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "DAGBO-SIGNAL/1.0" } });
  const rows = await response.json();
  if (!response.ok || !Array.isArray(rows)) throw new Error("Coinbase backup did not return candles");
  const values = rows.slice(0, 250).reverse().map(row => ({
    datetime: new Date(Number(row[0]) * 1000).toISOString().slice(0, 19).replace("T", " "),
    low: String(row[1]), high: String(row[2]), open: String(row[3]), close: String(row[4]), volume: String(row[5])
  }));
  if (values.length < 30) throw new Error("Coinbase returned fewer than 30 candles");
  return { pair, symbol: product, timeframe: tf, provider: "Coinbase Exchange · Public Market Data", providerExchange: "Coinbase", values };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const rawPair = String(req.query && req.query.pair || "").toUpperCase().trim();
  const pair = rawPair.replace(/[^A-Z0-9]/g, "");
  const tf = String(req.query && req.query.tf || "15");
  if (tf !== "5" && tf !== "15") return res.status(400).json({ error: "Timeframe must be 5 or 15 minutes" });

  const binanceSymbol = BINANCE_SYMBOLS[pair];
  if (binanceSymbol) {
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    try {
      const url = "https://data-api.binance.vision/api/v3/klines?symbol=" + encodeURIComponent(binanceSymbol) + "&interval=" + tf + "m&limit=250";
      const response = await fetch(url, { headers: { "Accept": "application/json" } });
      const rows = await response.json();
      if (!response.ok || !Array.isArray(rows)) throw new Error(rows && rows.msg ? rows.msg : "Binance candles unavailable");
      const values = rows.map(row => ({
        datetime: new Date(Number(row[0])).toISOString().slice(0, 19).replace("T", " "),
        open: String(row[1]), high: String(row[2]), low: String(row[3]), close: String(row[4]), volume: String(row[5])
      }));
      if (values.length < 30) throw new Error("Binance returned fewer than 30 candles");
      return res.status(200).json({ pair, symbol: binanceSymbol, timeframe: tf, provider: "Binance Spot · Public Market Data", providerExchange: "Binance", values });
    } catch (error) {
      console.error("DAGBO Binance primary failed; trying Coinbase:", error.message);
      try {
        const backup = await coinbaseCandles(pair, tf);
        return res.status(200).json(backup);
      } catch (backupError) {
        console.error("DAGBO Coinbase backup failed:", backupError.message);
        return res.status(502).json({ error: "Binance and Coinbase market candles are temporarily unavailable.", providers: ["Binance", "Coinbase"] });
      }
    }
  }

  const symbol = SYMBOLS[pair];
  if (!symbol) return res.status(400).json({ error: "Unsupported market pair" });
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Market data is not configured. Add TWELVE_DATA_API_KEY in Vercel." });
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  try {
    const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(symbol) +
      "&interval=" + tf + "min&outputsize=250&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
      return res.status(502).json({ error: data.message || "Market data provider did not return candles", provider: "Twelve Data" });
    }
    return res.status(200).json({ pair, timeframe: tf, provider: "Twelve Data", providerExchange: data.meta && data.meta.exchange ? data.meta.exchange : null, values: data.values });
  } catch (error) {
    console.error("DAGBO market data proxy error:", error.message);
    return res.status(502).json({ error: "Could not retrieve market candles" });
  }
};

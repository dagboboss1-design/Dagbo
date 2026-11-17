const SYMBOLS = {
  XAUUSD: "XAU/USD", GOLD: "XAU/USD",
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY", GBPJPY: "GBP/JPY",
  AUDUSD: "AUD/USD", USDCHF: "USD/CHF", USDCAD: "USD/CAD", NZDUSD: "NZD/USD",
  EURJPY: "EUR/JPY", EURGBP: "EUR/GBP",
  US30: "DJI", US100: "NDX", NAS100: "NDX", US500: "SPX"
};

const BINANCE_SYMBOLS = {
  BTC: "BTCUSDT", BTCUSD: "BTCUSDT", BTCUSDT: "BTCUSDT",
  ETH: "ETHUSDT", ETHUSD: "ETHUSDT", ETHUSDT: "ETHUSDT"
};

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
        encodeURIComponent(binanceSymbol) + "&interval=" + tf + "m&limit=100";
      const response = await fetch(url, { headers: { "Accept": "application/json" } });
      const rows = await response.json();
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
      return res.status(502).json({ error: "Could not retrieve Binance market candles. Please retry shortly.", provider: "Binance" });
    }
  }

  const symbol = SYMBOLS[pair];
  if (!symbol) return res.status(400).json({ error: "Unsupported market pair" });

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Market data is not configured. Add TWELVE_DATA_API_KEY in Vercel." });

  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  try {
    const url = "https://api.twelvedata.com/time_series?symbol=" +
      encodeURIComponent(symbol) +
      "&interval=" + interval.twelve + "&outputsize=100&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
      return res.status(502).json({ error: data.message || "Market data provider did not return candles", provider: "Twelve Data" });
    }

    return res.status(200).json({
      pair, timeframe: tf, provider: "Twelve Data",
      providerExchange: data.meta && data.meta.exchange ? data.meta.exchange : null,
      values: data.values
    });
  } catch (error) {
    console.error("DAGBO market data proxy error:", error.message);
    return res.status(502).json({ error: "Could not retrieve market candles" });
  }
};

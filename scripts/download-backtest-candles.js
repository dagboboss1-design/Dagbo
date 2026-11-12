"use strict";

// Fetch one bounded historical candle batch per priority instrument.
// API keys are read only from environment variables and never written to output.
const fs = require("node:fs");
const path = require("node:path");
const { SYMBOLS, normalizeCandles } = require("../lib/spike-engine");

const apiKey = process.env.TWELVE_DATA_API_KEY;
if (!apiKey) {
  console.error("Missing TWELVE_DATA_API_KEY environment secret.");
  process.exit(1);
}

const pairs = ["EURUSD", "GBPUSD", "GBPJPY", "XAUUSD"];
const outputDir = path.resolve("data/backtest");
const outputsize = Math.min(5000, Math.max(100, Number(process.env.HISTORY_OUTPUTSIZE || 5000)));
const interval = process.env.HISTORY_INTERVAL || "5min";

async function download(pair) {
  const symbol = SYMBOLS[pair];
  const url = new URL("https://api.twelvedata.com/time_series");
  url.search = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(outputsize),
    timezone: "UTC",
    apikey: apiKey
  }).toString();

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
    const message = String(data.message || data.code || response.statusText || "Provider request failed");
    throw new Error(pair + " (" + symbol + "): " + message);
  }

  const candles = normalizeCandles(data.values);
  if (candles.length < 30) {
    throw new Error(pair + " (" + symbol + "): only " + candles.length + " valid candles returned; at least 30 are required.");
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, pair + ".json");
  fs.writeFileSync(file, JSON.stringify({
    provider: "Twelve Data",
    pair,
    providerSymbol: symbol,
    interval,
    requestedOutputsize: outputsize,
    downloadedAt: new Date().toISOString(),
    candleCount: candles.length,
    values: candles
  }, null, 2) + "\n");

  return {
    pair,
    providerSymbol: symbol,
    candleCount: candles.length,
    firstCandle: candles[0].datetime,
    lastCandle: candles[candles.length - 1].datetime,
    file
  };
}

(async () => {
  const report = [];
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    try {
      report.push({ ...await download(pair), status: "downloaded" });
    } catch (error) {
      report.push({ pair, status: "failed", error: String(error.message).slice(0, 220) });
    }
    // Keep requests comfortably below the documented 8-requests/minute limit.
    if (index < pairs.length - 1) await new Promise(resolve => setTimeout(resolve, 8000));
  }

  console.log(JSON.stringify({
    provider: "Twelve Data",
    interval,
    requestedOutputsize: outputsize,
    results: report,
    successful: report.filter(item => item.status === "downloaded").length,
    failed: report.filter(item => item.status === "failed").length,
    note: "This downloads a bounded historical sample. Available depth depends on the Twelve Data plan and instrument."
  }, null, 2));

  if (report.some(item => item.status === "failed")) process.exitCode = 1;
})();

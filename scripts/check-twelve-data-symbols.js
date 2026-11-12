"use strict";

// Checks Twelve Data coverage without printing or transmitting the API key anywhere
// except directly to Twelve Data. Default is a small smoke test; pass --all to
// check every unique provider symbol mapped by the spike engine.
const { SYMBOLS } = require("../lib/spike-engine");

const API_KEY = process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) {
  console.error("Missing TWELVE_DATA_API_KEY. Set it as an environment variable; do not paste it into source code.");
  process.exit(1);
}

const corePairs = ["EURUSD", "GBPUSD", "GBPJPY", "XAUUSD"];
const selectedPairs = process.argv.includes("--all") ? Object.keys(SYMBOLS) : corePairs;
const providerSymbols = [...new Set(selectedPairs.map(pair => SYMBOLS[pair]).filter(Boolean))];

async function check(symbol) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.search = new URLSearchParams({
    symbol,
    interval: "5min",
    outputsize: "2",
    timezone: "UTC",
    apikey: API_KEY
  }).toString();

  try {
    const response = await fetch(url);
    const data = await response.json();
    const ok = response.ok && data.status !== "error" &&
      Array.isArray(data.values) && data.values.length > 0;
    return {
      providerSymbol: symbol,
      available: ok,
      candlesReturned: ok ? data.values.length : 0,
      message: ok ? "OK" : String(data.message || data.code || "No candle data returned").slice(0, 180)
    };
  } catch (error) {
    return {
      providerSymbol: symbol,
      available: false,
      candlesReturned: 0,
      message: String(error.message || "Request failed").slice(0, 180)
    };
  }
}

(async () => {
  const results = [];
  let dailyQuotaExhausted = false;
  // Twelve Data Basic allows 8 requests/minute; wait 8 seconds between calls.
  for (const [index, symbol] of providerSymbols.entries()) {
    const result = await check(symbol);
    results.push(result);
    if (!result.available && /daily.*credit|credit.*daily|daily limit|800 credits/i.test(result.message)) {
      dailyQuotaExhausted = true;
      break;
    }
    if (index < providerSymbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
  }

  const pairResults = selectedPairs.map(pair => {
    const providerSymbol = SYMBOLS[pair];
    const result = results.find(item => item.providerSymbol === providerSymbol);
    return {
      pair,
      providerSymbol,
      available: result ? result.available : null,
      status: result ? (result.available ? "available" : "unavailable") : "not_checked"
    };
  });

  const report = {
    provider: "Twelve Data",
    interval: "5min",
    checkedAt: new Date().toISOString(),
    checkedPairs: pairResults.length,
    availablePairs: pairResults.filter(item => item.available === true).length,
    notCheckedPairs: pairResults.filter(item => item.status === "not_checked").length,
    dailyQuotaExhausted,
    pairs: pairResults,
    providerSymbols: results,
    note: "Requests are spaced 8 seconds apart to respect the 8-requests/minute limit. Not-checked pairs are not classified as unsupported. Availability is an account- and plan-dependent smoke test, not a guarantee of uninterrupted data or historical depth."
  };
  console.log(JSON.stringify(report, null, 2));
  if (results.some(item => !item.available)) process.exitCode = 2;
})();

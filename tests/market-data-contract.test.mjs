import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateMarketData, normalizeCandle } = require("../src/core/market-data-contract.js");
const candles = Array.from({ length: 32 }, (_, i) => ({
  datetime: new Date(Date.UTC(2026, 0, 1, 0, i * 15)).toISOString().slice(0, 19).replace("T", " "),
  open: "1.1000", high: "1.1020", low: "1.0990", close: "1.1010", volume: "100"
}));

test("accepts complete, ordered provider candles and returns canonical direct-data payload", () => {
  const result = validateMarketData({ pair: "eurusd", timeframe: "15", provider: "Twelve Data", values: candles });
  assert.equal(result.valid, true);
  assert.equal(result.payload.pair, "EURUSD");
  assert.equal(result.payload.marketDataType, "DIRECT");
  assert.equal(result.payload.values.length, 32);
});

test("rejects malformed OHLC, duplicate timestamps, missing provider and thin history", () => {
  assert.equal(normalizeCandle({ datetime: "2026-01-01 00:00:00", open: 2, high: 1, low: 0.5, close: 1 }).length, undefined);
  const malformed = candles.map(row => ({ ...row }));
  malformed[4].high = "1.0000";
  assert.equal(validateMarketData({ pair: "EURUSD", timeframe: "15", provider: "Twelve Data", values: malformed }).valid, false);
  const duplicate = candles.map(row => ({ ...row }));
  duplicate[5].datetime = duplicate[4].datetime;
  assert.equal(validateMarketData({ pair: "EURUSD", timeframe: "15", provider: "Twelve Data", values: duplicate }).valid, false);
  assert.equal(validateMarketData({ pair: "EURUSD", timeframe: "15", values: candles }).valid, false);
  assert.equal(validateMarketData({ pair: "EURUSD", timeframe: "15", provider: "Twelve Data", values: candles.slice(0, 10) }).valid, false);
});

test("rejects unsupported timeframes and non-positive prices", () => {
  assert.equal(validateMarketData({ pair: "EURUSD", timeframe: "2", provider: "Twelve Data", values: candles }).valid, false);
  const invalid = candles.map(row => ({ ...row }));
  invalid[0].close = "0";
  assert.equal(validateMarketData({ pair: "EURUSD", timeframe: "15", provider: "Twelve Data", values: invalid }).valid, false);
});

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runBacktest } = require("../lib/spike-backtest");

const file = process.argv[2];
const pair = process.argv[3] || "UNKNOWN";
if (!file) {
  console.error("Usage: node scripts/backtest-spike.js <candles.json> [PAIR]");
  process.exit(2);
}
const resolved = path.resolve(file);
const payload = JSON.parse(fs.readFileSync(resolved, "utf8"));
const candles = Array.isArray(payload) ? payload : payload.values;
if (!Array.isArray(candles)) {
  console.error("Input must be a candle array or an object containing a values array.");
  process.exit(2);
}
const report = runBacktest(candles, {
  pair,
  horizonBars: Number(process.env.HORIZON_BARS || 3),
  spikeThreshold: Number(process.env.SPIKE_THRESHOLD || 60),
  spikeAtrMultiple: Number(process.env.SPIKE_ATR_MULTIPLE || 1.5),
  targetAtr: Number(process.env.TARGET_ATR || 1),
  stopAtr: Number(process.env.STOP_ATR || 0.75),
  minAgreementPct: Number(process.env.MIN_AGREEMENT_PCT || 75),
  roundTripCost: Number(process.env.ROUND_TRIP_COST || 0)
});
console.log(JSON.stringify(report, null, 2));

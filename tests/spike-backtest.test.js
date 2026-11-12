"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runBacktest } = require("../lib/spike-backtest");

function sampleCandles(count) {
  const rows = [];
  let price = 1.1;
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < count; i++) {
    const move = i > 35 ? (i % 2 ? 0.0008 : -0.0006) : 0.0001;
    const open = price;
    const close = price + move;
    rows.push({
      datetime: new Date(start + i * 5 * 60000).toISOString(),
      open, close,
      high: Math.max(open, close) + (i > 35 ? 0.0007 : 0.0001),
      low: Math.min(open, close) - (i > 35 ? 0.0007 : 0.0001),
      volume: 100 + i
    });
    price = close;
  }
  return rows;
}

test("walk-forward backtest reports separate spike and directional metrics", () => {
  const report = runBacktest(sampleCandles(100), { pair: "EURUSD" });
  assert.equal(report.pair, "EURUSD");
  assert.ok(report.evaluatedSignals > 0);
  assert.equal(report.spikeDetection.tp + report.spikeDetection.fp +
    report.spikeDetection.fn + report.spikeDetection.tn, report.evaluatedSignals);
  assert.ok(Array.isArray(report.scoreBuckets));
  assert.equal(report.assumptions.sameCandleTargetAndStop, "counted as a loss");
});

test("backtest refuses to invent results when candle history is too short", () => {
  const report = runBacktest(sampleCandles(20));
  assert.equal(report.evaluatedSignals, 0);
  assert.equal(report.spikeDetection.precision, null);
  assert.equal(report.directional.winRate, null);
});

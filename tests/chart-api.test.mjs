import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const handler = require("../api/chart.js");

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request(pair, interval = "15") {
  return { method: "GET", query: { pair, interval } };
}

test("chart endpoint refuses ETF proxy prices for index CFD symbols", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch an ETF proxy"); };
  try {
    for (const pair of ["US30", "US100", "NAS100", "US500"]) {
      const res = responseStub();
      await handler(request(pair), res);
      assert.equal(res.statusCode, 503, pair);
      assert.equal(res.body.marketDataType, "UNAVAILABLE", pair);
      assert.match(res.body.error, /exact index CFD feed/i, pair);
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chart endpoint rejects unsupported timeframes before provider access", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try {
    const res = responseStub();
    await handler(request("EURUSD", "2"), res);
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chart endpoint returns only validated direct Twelve Data candles", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TWELVE_DATA_API_KEY;
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const values = Array.from({ length: 35 }, (_, i) => ({
    datetime: new Date(Date.UTC(2026, 0, 1, 0, i * 15)).toISOString().slice(0, 19).replace("T", " "),
    open: "1.1000", high: "1.1020", low: "1.0990", close: "1.1010", volume: "100"
  }));
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ meta: { symbol: "EUR/USD" }, values })
  });
  try {
    const res = responseStub();
    await handler(request("EURUSD"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.marketDataType, "DIRECT");
    assert.equal(res.body.candles.length, 35);
    assert.equal(res.body.sourceSymbol, "EUR/USD");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalKey;
  }
});

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

function providerResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data)
  };
}

function candles(count = 35) {
  return Array.from({ length: count }, (_, i) => ({
    datetime: new Date(Date.UTC(2026, 0, 1, 0, i * 15)).toISOString().slice(0, 19).replace("T", " "),
    open: "1.1000", high: "1.1020", low: "1.0990", close: "1.1010", volume: "100"
  }));
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

test("chart endpoint uses the shared Twelve Data manager and returns validated candles", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TWELVE_DATA_API_KEY;
  const originalFcsKey = process.env.FCS_API_KEY;
  process.env.TWELVE_DATA_API_KEY = "test-key";
  delete process.env.FCS_API_KEY;
  globalThis.fetch = async () => providerResponse({ meta: { symbol: "EUR/USD", exchange: "FX" }, values: candles() });
  try {
    const res = responseStub();
    await handler(request("EURUSD"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.marketDataType, "DIRECT");
    assert.equal(res.body.candles.length, 35);
    assert.equal(res.body.source, "Twelve Data");
    assert.equal(res.body.sourceSymbol, "EURUSD");
    assert.equal(res.body.candles[0].time, Math.floor(Date.UTC(2026, 0, 1) / 1000));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("TWELVE_DATA_API_KEY", originalKey);
    restoreEnv("FCS_API_KEY", originalFcsKey);
  }
});

test("chart endpoint fails over to FCS when Twelve Data is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TWELVE_DATA_API_KEY;
  const originalFcsKey = process.env.FCS_API_KEY;
  process.env.TWELVE_DATA_API_KEY = "test-key";
  process.env.FCS_API_KEY = "test-fcs-key";
  const fcsRows = candles().map(row => ({
    tm: row.datetime, o: row.open, h: row.high, l: row.low, c: row.close, v: row.volume
  }));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return providerResponse({ status: "error", message: "Twelve Data unavailable" }, 429);
    return providerResponse({ status: true, code: 200, response: fcsRows });
  };
  try {
    const res = responseStub();
    await handler(request("EURUSD"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.source, "FCS");
    assert.equal(res.body.failover, true);
    assert.equal(res.body.marketDataType, "DIRECT");
    assert.equal(res.body.candles.length, 35);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("TWELVE_DATA_API_KEY", originalKey);
    restoreEnv("FCS_API_KEY", originalFcsKey);
  }
});

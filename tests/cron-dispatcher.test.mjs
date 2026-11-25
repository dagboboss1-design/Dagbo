import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dispatcher = require("../api/cron-signal.js");
const scanner = require("../api/cron-scan.js");
const news = require("../lib/news-monitor.js");

function responseStub() {
  return {
    statusCode: 200,
    body: null,
    setHeader() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("scheduled workers can be imported without Redis environment variables", () => {
  assert.equal(typeof dispatcher, "function");
  assert.equal(typeof scanner, "function");
  assert.equal(typeof news.runNewsMonitor, "function");
});

test("cron dispatcher returns a controlled configuration error when Redis is missing", async () => {
  const names = [
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
    "DAGBO_CRON_SECRET", "CRON_SECRET", "SIGNAL_PUSH_SECURITY",
    "Signal_push_security", "SIGNAL_PUSH_SECRET"
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.DAGBO_CRON_SECRET = "test-cron-secret";
  try {
    const res = responseStub();
    await dispatcher({
      method: "GET",
      headers: { authorization: "Bearer test-cron-secret" }
    }, res);
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /Upstash Redis is not configured/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

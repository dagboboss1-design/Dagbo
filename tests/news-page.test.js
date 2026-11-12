"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("news.html", "utf8");

test("News page keeps its existing news features and adds spike controls", () => {
  for (const id of [
    "newsCountdown", "newsEventTitle", "refreshCalendar", "newsHeadlines",
    "refreshNews", "openNewsAI", "spikePair", "runLiveSpike",
    "runPreNewsSpike", "spikeResult"
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), "Missing element: " + id);
  }
  assert.match(html, /\/api\/market-data\?pair=/);
  assert.match(html, /runSpikeScan\('pre-news'/);
  assert.match(html, /runSpikeScan\('live'/);
});

test("News page inline JavaScript parses without syntax errors", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.ok(scripts.length >= 2, "Expected inline page scripts");
  scripts.forEach((source, index) => {
    assert.doesNotThrow(() => new vm.Script(source, { filename: "news-inline-" + index + ".js" }));
  });
});

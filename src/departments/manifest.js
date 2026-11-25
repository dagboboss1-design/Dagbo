/**
 * Single-app department ownership map. Core is shared infrastructure, not a department.
 * Capabilities describe the existing product surface; integration status is
 * determined by runtime health checks, never by this manifest.
 */
export const DEPARTMENTS = Object.freeze([
  { id: "trade", name: "DAGBO TRADE", description: "Signals, charts, alerts and execution.", routes: ["signals.html", "chart.html", "alerts.html"], capabilities: ["signals", "chart", "alerts", "execution"] },
  { id: "intelligence", name: "DAGBO INTELLIGENCE", description: "News, economic calendar, sentiment and market context.", routes: ["news.html", "market-heatmap.html", "signal-insights.html"], capabilities: ["news", "calendar", "sentiment", "opportunities"] },
  { id: "quant", name: "DAGBO QUANT", description: "Trading profiles, strategy research and higher-timeframe analysis.", routes: ["strategy-lab.html", "strategy-profiles.html", "higher-timeframe-hedging.html"], capabilities: ["profiles", "strategy-research", "higher-timeframe", "hedging"] },
  { id: "journal", name: "DAGBO JOURNAL", description: "Trade records, risk tracking, replay and performance.", routes: ["journal.html", "trader-score.html", "replay.html"], capabilities: ["journal", "risk", "replay", "performance"] },
  { id: "ai", name: "DAGBO AI", description: "AI assistant and BOSS1 analysis.", routes: ["ai.html", "boss1.html"], capabilities: ["assistant", "boss1"] },
  { id: "academy", name: "DAGBO ACADEMY", description: "Trading education and worked examples.", routes: ["learn.html"], capabilities: ["lessons", "examples"] }
]);

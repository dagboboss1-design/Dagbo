/**
 * Department ownership map. Routes point to existing pages so this rollout
 * preserves the current single-app navigation and URLs.
 */
export const DEPARTMENTS = Object.freeze([
  { id: "trade", name: "DAGBO TRADE", description: "Signal board, trade opportunities and execution.", routes: ["signals.html", "chart.html", "alerts.html"] },
  { id: "intelligence", name: "DAGBO INTELLIGENCE", description: "Market news, economic calendar and fundamental context.", routes: ["news.html", "market-heatmap.html", "signal-insights.html"] },
  { id: "quant", name: "DAGBO QUANT", description: "Trading profiles, strategy research and scanning diagnostics.", routes: ["strategy-lab.html", "strategy-profiles.html", "higher-timeframe-hedging.html"] },
  { id: "journal", name: "DAGBO JOURNAL", description: "Trade records, risk tracking and performance review.", routes: ["journal.html", "trader-score.html", "replay.html"] },
  { id: "ai", name: "DAGBO AI", description: "AI assistant and BOSS1 analysis experience.", routes: ["ai.html", "boss1.html"] },
  { id: "academy", name: "DAGBO ACADEMY", description: "Trading education and worked examples.", routes: ["learn.html"] }
]);

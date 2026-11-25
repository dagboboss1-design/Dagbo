import { registerEngine, readJson, requirePage, publish } from "../engine-kit.js";
const ID = "quant";
const ROUTES = ["strategy-lab.html", "strategy-profiles.html", "higher-timeframe-hedging.html"];
export function registerQuantEngine(core, win = window, doc = document) {
  return registerEngine(core, { id: ID }, {
    status: async () => ({ department: ID, boundary: "isolated", routes: ROUTES }),
    profiles: async () => {
      if (!win.DagboStrategyProfiles || typeof win.DagboStrategyProfiles.getProfiles !== "function") {
        return { available: false, reason: "Strategy profile catalogue is not loaded on this page." };
      }
      return { available: true, profiles: win.DagboStrategyProfiles.getProfiles() };
    },
    "refresh-higher-timeframe": async () => {
      const page = requirePage(win, ["higher-timeframe-hedging.html"]);
      if (!page.available) return page;
      const button = doc.getElementById("refreshH4");
      if (!button) throw new Error("Higher-timeframe analysis control is missing.");
      button.click();
      publish(core, "quant:higher-timeframe-refresh", { page: page.page });
      return { available: true, refreshed: true };
    },
    "refresh-hedge": async () => {
      const page = requirePage(win, ["higher-timeframe-hedging.html"]);
      if (!page.available) return page;
      const button = doc.getElementById("refresh-hedge");
      if (!button) throw new Error("Hedge analysis control is missing.");
      button.click();
      publish(core, "quant:hedge-refresh", { page: page.page });
      return { available: true, refreshed: true };
    },
    performance: async () => {
      const trades = readJson(win.localStorage, "dagbo_journal", []);
      const closed = Array.isArray(trades) ? trades.filter(t => ["WIN", "LOSS", "BREAKEVEN"].includes(t.result)) : [];
      return { closedTrades: closed.length, strategies: [...new Set(closed.map(t => t.strategy || "Not tagged"))] };
    }
  }, [{ name: "quant-page-adapters", run: async () => ROUTES.length === 3 }]);
}

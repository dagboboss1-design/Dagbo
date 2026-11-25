import { registerEngine, readJson, requirePage, publish } from "../engine-kit.js";
const ID = "trade";
const ROUTES = ["signals.html", "chart.html", "alerts.html"];
export function registerTradeEngine(core, win = window, doc = document) {
  return registerEngine(core, { id: ID }, {
    status: async () => ({ department: ID, boundary: "isolated", routes: ROUTES }),
    "refresh-signals": async () => {
      const page = requirePage(win, ["signals.html"]);
      if (!page.available) return page;
      if (typeof win.loadAllSignals !== "function") throw new Error("Signals engine is not available on this page.");
      await win.loadAllSignals();
      publish(core, "trade:scan-requested", { page: page.page });
      return { available: true, refreshed: true };
    },
    "signal-snapshots": async () => ({
      fiveMinute: readJson(win.localStorage, "dagbo_signal_tf_snapshots", {})["5"] || {},
      fifteenMinute: readJson(win.localStorage, "dagbo_signal_tf_snapshots", {})["15"] || {},
      alerts: readJson(win.localStorage, "dagbo_alert_history", [])
    }),
    "chart-status": async () => {
      const page = requirePage(win, ["chart.html"]);
      if (!page.available) return page;
      return { available: true, chartContainer: !!doc.getElementById("tv-full-chart"), provider: "TradingView embed" };
    },
    "execute-trade": async input => {
      const page = requirePage(win, ["signals.html"]);
      if (!page.available) return page;
      if (typeof win.executeTrade !== "function") throw new Error("Trade execution is not available.");
      return win.execute-trade(input);
    }
  }, [{ name: "trade-page-adapters", run: async () => ROUTES.length === 3 }]);
}

import { registerEngine, readJson, requirePage, publish } from "../engine-kit.js";
const ID = "intelligence";
const ROUTES = ["news.html", "market-heatmap.html", "signal-insights.html"];
export function registerIntelligenceEngine(core, win = window, doc = document) {
  return registerEngine(core, { id: ID }, {
    status: async () => ({ department: ID, boundary: "isolated", routes: ROUTES }),
    refresh: async () => {
      const page = requirePage(win, ROUTES);
      if (!page.available) return page;
      let refreshed = [];
      ["refreshCalendar", "refreshNews", "refreshHeatmap"].forEach(id => {
        const button = doc.getElementById(id);
        if (button) { button.click(); refreshed.push(id); }
      });
      publish(core, "intelligence:refresh-requested", { page: page.page, refreshed });
      return { available: true, refreshed };
    },
    marketContext: async () => ({
      signalSnapshots: readJson(win.localStorage, "dagbo_signal_tf_snapshots", {}),
      newsContext: readJson(win.localStorage, "dagbo_news_signal_context", {}),
      lastRefresh: readJson(win.localStorage, "dagbo_news_last_refresh", null)
    })
  }, [{ name: "intelligence-page-adapters", run: async () => ROUTES.length === 3 }]);
}

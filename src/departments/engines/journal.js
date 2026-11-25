import { registerEngine, readJson, requirePage, publish } from "../engine-kit.js";
const ID = "journal";
const ROUTES = ["journal.html", "trader-score.html", "replay.html"];
export function registerJournalEngine(core, win = window, doc = document) {
  return registerEngine(core, { id: ID }, {
    status: async () => ({ department: ID, boundary: "isolated", routes: ROUTES }),
    trades: async () => {
      const rows = readJson(win.localStorage, "dagbo_journal", []);
      return Array.isArray(rows) ? rows : [];
    },
    refresh: async () => {
      const page = requirePage(win, ROUTES);
      if (!page.available) return page;
      const button = doc.getElementById("load");
      if (page.page === "replay.html" && button) button.click();
      else win.dispatchEvent(new CustomEvent("dagbo:journal-refresh"));
      publish(core, "journal:refresh-requested", { page: page.page });
      return { available: true, page: page.page };
    },
    performance: async () => {
      const rows = readJson(win.localStorage, "dagbo_journal", []);
      const trades = Array.isArray(rows) ? rows : [];
      const closed = trades.filter(t => ["WIN", "LOSS", "BREAKEVEN"].includes(t.result));
      const wins = closed.filter(t => t.result === "WIN").length;
      return { total: trades.length, closed: closed.length, wins, winRate: closed.length ? wins / closed.length : null };
    }
  }, [{ name: "journal-page-adapters", run: async () => ROUTES.length === 3 }]);
}

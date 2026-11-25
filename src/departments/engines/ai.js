import { registerEngine, requirePage, publish } from "../engine-kit.js";
const ID = "ai";
const ROUTES = ["ai.html", "boss1.html"];
export function registerAIEngine(core, win = window, doc = document) {
  return registerEngine(core, { id: ID }, {
    status: async () => ({ department: ID, boundary: "isolated", routes: ROUTES }),
    ask: async input => {
      const page = requirePage(win, ["ai.html"]);
      if (!page.available) return page;
      const field = doc.getElementById("chatInput");
      if (!field || typeof win.sendMessage !== "function") throw new Error("AI chat engine is not ready.");
      const message = String(input && input.message || "").trim();
      if (!message) throw new TypeError("AI message cannot be empty.");
      field.value = message;
      win.sendMessage();
      publish(core, "ai:message-submitted", { length: message.length });
      return { available: true, submitted: true };
    },
    openLesson: async input => {
      const page = requirePage(win, ROUTES);
      if (!page.available) return page;
      const query = String(input && input.query || "").trim();
      if (page.page === "ai.html") {
        const field = doc.getElementById("chatInput");
        if (!field || typeof win.askQuestion !== "function") throw new Error("AI lesson interface is not ready.");
        win.askQuestion(query || "Teach me a trading concept with an example.");
      } else {
        const search = doc.getElementById("eduSearch");
        if (search) { search.value = query; search.dispatchEvent(new Event("input", { bubbles: true })); }
      }
      return { available: true, page: page.page };
    }
  }, [{ name: "ai-page-adapters", run: async () => ROUTES.length === 2 }]);
}

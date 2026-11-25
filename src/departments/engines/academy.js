import { registerEngine, requirePage, publish } from "../engine-kit.js";
const ID = "academy";
const ROUTES = ["learn.html"];
export function registerAcademyEngine(core, win = window, doc = document) {
  return registerEngine(core, { id: ID }, {
    status: async () => ({ department: ID, boundary: "isolated", routes: ROUTES }),
    lessons: async () => {
      const page = requirePage(win, ROUTES);
      if (!page.available) return page;
      const headings = [...doc.querySelectorAll("main h2, main h3")].map(node => node.textContent.trim()).filter(Boolean);
      return { available: true, count: headings.length, titles: headings };
    },
    searchLessons: async input => {
      const page = requirePage(win, ROUTES);
      if (!page.available) return page;
      const query = String(input && input.query || "").trim();
      const field = doc.getElementById("eduSearch");
      if (!field) return { available: false, reason: "Academy search is not present on this page." };
      field.value = query;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      publish(core, "academy:lessons-filtered", { query });
      return { available: true, query };
    }
  }, [{ name: "academy-page-adapters", run: async () => !!doc && ROUTES.length === 1 }]);
}

/** Shared registration mechanics; domain behavior lives in each department module. */
export function registerEngine(core, definition, services, healthChecks = []) {
  const registered = [];
  for (const [name, implementation] of Object.entries(services)) {
    registered.push(core.registerService(definition.id, name, implementation));
  }
  const checks = [
    { name: "engine-module", run: async () => true },
    { name: "service-boundary", run: async () => registered.length > 0 },
    ...healthChecks
  ];
  return core.runHealthChecks(definition.id, checks);
}
export function readJson(storage, key, fallback) {
  try { const value = JSON.parse(storage && storage.getItem(key)); return value == null ? fallback : value; }
  catch (_) { return fallback; }
}
export function currentPage(win) {
  return String(win && win.location && win.location.pathname || "").split("/").pop() || "index.html";
}
export function requirePage(win, routes) {
  const page = currentPage(win);
  if (!routes.includes(page)) return { available: false, page, requiredRoutes: routes };
  return { available: true, page };
}
export function publish(core, event, payload) {
  core.publish(event, payload || {});
}

/**
 * DAGBO CORE — isolated department registry, service boundary, health and event bus.
 * No department can invoke another department's private services directly.
 */
const VALID_STATES = new Set(["ready", "degraded", "unavailable", "not-integrated"]);
const ID = /^[a-z][a-z0-9-]*$/;
const EVENT = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export function createDepartmentCore() {
  const departments = new Map();
  const services = new Map();
  const listeners = new Map();
  const routeOwners = new Map();

  function register(definition) {
    if (!definition || !ID.test(definition.id || "")) throw new TypeError("A department requires a valid id.");
    if (departments.has(definition.id)) throw new Error("Department already registered: " + definition.id);
    const routes = [...new Set((definition.routes || []).map(route => String(route).replace(/^\//, "")))];
    for (const route of routes) {
      if (!route || route.includes("..")) throw new TypeError("Invalid department route: " + route);
      const owner = routeOwners.get(route);
      if (owner) throw new Error("Route " + route + " already belongs to " + owner);
    }
    routes.forEach(route => routeOwners.set(route, definition.id));
    const record = Object.freeze({
      id: definition.id, name: String(definition.name || definition.id),
      description: String(definition.description || ""), routes: Object.freeze(routes),
      capabilities: Object.freeze([...(definition.capabilities || [])]),
      state: "not-integrated", checks: Object.freeze([]), registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    departments.set(record.id, record);
    services.set(record.id, new Map());
    emit("core:department-registered", record);
    return record;
  }

  function registerService(departmentId, serviceId, implementation) {
    if (!departments.has(departmentId)) throw new Error("Unknown department: " + departmentId);
    if (!ID.test(serviceId || "") || typeof implementation !== "function") {
      throw new TypeError("A service requires a valid id and function implementation.");
    }
    const owned = services.get(departmentId);
    if (owned.has(serviceId)) throw new Error("Service already registered: " + departmentId + ":" + serviceId);
    owned.set(serviceId, implementation);
    emit(departmentId + ":service-registered", { departmentId, serviceId });
    return () => owned.delete(serviceId);
  }

  async function invoke(departmentId, serviceId, input) {
    const owned = services.get(departmentId);
    if (!owned) throw new Error("Unknown department: " + departmentId);
    const implementation = owned.get(serviceId);
    if (!implementation) throw new Error("Unknown service: " + departmentId + ":" + serviceId);
    return implementation(input);
  }

  function updateHealth(id, state, checks = []) {
    if (!VALID_STATES.has(state)) throw new TypeError("Invalid department state.");
    const current = departments.get(id);
    if (!current) throw new Error("Unknown department: " + id);
    const safeChecks = checks.map(check => Object.freeze({
      name: String(check.name || "check"),
      state: VALID_STATES.has(check.state) ? check.state : "unavailable",
      detail: String(check.detail || "")
    }));
    const next = Object.freeze({ ...current, state, checks: Object.freeze(safeChecks), updatedAt: new Date().toISOString() });
    departments.set(id, next);
    emit("core:department-health", next);
    return next;
  }

  async function runHealthChecks(id, checks) {
    if (!departments.has(id)) throw new Error("Unknown department: " + id);
    const results = await Promise.all((checks || []).map(async check => {
      try {
        const result = await check.run();
        return { name: check.name, state: result === false ? "degraded" : "ready",
          detail: typeof result === "string" ? result : (result === false ? "Check returned false" : "OK") };
      } catch (error) {
        return { name: check.name, state: "unavailable", detail: String(error && error.message || error) };
      }
    }));
    const states = results.map(item => item.state);
    const state = states.length === 0 ? "not-integrated" :
      states.every(value => value === "ready") ? "ready" :
      states.every(value => value === "unavailable") ? "unavailable" : "degraded";
    return updateHealth(id, state, results);
  }

  function list() { return [...departments.values()]; }
  function get(id) { return departments.get(id) || null; }
  function ownerOf(route) { return routeOwners.get(String(route || "").replace(/^\//, "")) || null; }
  function subscribe(eventName, listener) {
    if (typeof listener !== "function") throw new TypeError("Listener must be a function.");
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    listeners.get(eventName).add(listener);
    return () => listeners.get(eventName)?.delete(listener);
  }
  function emit(eventName, payload) {
    for (const listener of listeners.get(eventName) || []) {
      try { listener(payload); } catch (error) { console.error("[DAGBO CORE] event listener failed:", eventName, error); }
    }
  }
  function publish(eventName, payload = {}) {
    if (!EVENT.test(eventName || "")) throw new TypeError("Events must use department:event naming.");
    const owner = eventName.split(":")[0];
    if (!departments.has(owner) && owner !== "core") throw new Error("Unknown event owner: " + owner);
    emit(eventName, Object.freeze({ ...payload, emittedAt: new Date().toISOString() }));
  }
  return Object.freeze({ register, registerService, invoke, runHealthChecks, updateHealth, list, get, ownerOf, subscribe, publish });
}

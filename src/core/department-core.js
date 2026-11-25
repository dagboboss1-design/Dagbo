/**
 * DAGBO CORE — department boundary and event bus.
 * This is an additive foundation. Existing page scripts remain the source of
 * production behaviour until each department is migrated and verified.
 */
const VALID_STATES = new Set(["ready", "degraded", "unavailable", "not-integrated"]);

export function createDepartmentCore() {
  const departments = new Map();
  const listeners = new Map();

  function register(definition) {
    if (!definition || !/^[a-z][a-z0-9-]*$/.test(definition.id || "")) {
      throw new TypeError("A department requires a valid id.");
    }
    if (departments.has(definition.id)) {
      throw new Error("Department already registered: " + definition.id);
    }
    const record = Object.freeze({
      id: definition.id,
      name: String(definition.name || definition.id),
      description: String(definition.description || ""),
      routes: Object.freeze([...(definition.routes || [])]),
      state: "not-integrated",
      checks: Object.freeze([]),
      updatedAt: new Date().toISOString()
    });
    departments.set(record.id, record);
    emit("core:department-registered", record);
    return record;
  }

  function updateHealth(id, state, checks = []) {
    if (!VALID_STATES.has(state)) throw new TypeError("Invalid department state.");
    const current = departments.get(id);
    if (!current) throw new Error("Unknown department: " + id);
    const next = Object.freeze({
      ...current,
      state,
      checks: Object.freeze(checks.map(check => Object.freeze({
        name: String(check.name || "check"),
        state: VALID_STATES.has(check.state) ? check.state : "unavailable",
        detail: String(check.detail || "")
      }))),
      updatedAt: new Date().toISOString()
    });
    departments.set(id, next);
    emit("core:department-health", next);
    return next;
  }

  function list() { return [...departments.values()]; }
  function get(id) { return departments.get(id) || null; }

  function subscribe(eventName, listener) {
    if (typeof listener !== "function") throw new TypeError("Listener must be a function.");
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    listeners.get(eventName).add(listener);
    return () => listeners.get(eventName)?.delete(listener);
  }

  function emit(eventName, payload) {
    for (const listener of listeners.get(eventName) || []) {
      try { listener(payload); } catch (error) {
        console.error("[DAGBO CORE] event listener failed:", eventName, error);
      }
    }
  }

  function publish(eventName, payload) {
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(eventName || "")) {
      throw new TypeError("Events must use department:event naming.");
    }
    emit(eventName, Object.freeze({ ...payload, emittedAt: new Date().toISOString() }));
  }

  return Object.freeze({ register, updateHealth, list, get, subscribe, publish });
}

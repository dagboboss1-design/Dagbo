import { createDepartmentCore } from "../core/department-core.js";
import { DEPARTMENTS } from "./manifest.js";

export const dagboCore = createDepartmentCore();
for (const department of DEPARTMENTS) dagboCore.register(department);

// Register an explicit page-boundary adapter for each department. Existing
// page engines stay in place until migrated; adapters report that honestly.
for (const department of DEPARTMENTS) {
  dagboCore.registerService(department.id, "describe", () => ({
    id: department.id, routes: department.routes, capabilities: department.capabilities,
    integration: "legacy-page-engine"
  }));
  dagboCore.updateHealth(department.id, "not-integrated", [{
    name: "engine-boundary", state: "not-integrated",
    detail: "Department ownership and service boundary are registered; legacy page engine remains active."
  }]);
}

if (typeof window !== "undefined") {
  window.DAGBO_CORE = dagboCore;
  window.dispatchEvent(new CustomEvent("dagbo:departments-ready", {
    detail: { departments: dagboCore.list(), health: dagboCore.healthSummary(), coreVersion: 2 }
  }));
}

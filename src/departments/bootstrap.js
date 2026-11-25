import { createDepartmentCore } from "../core/department-core.js";
import { DEPARTMENTS } from "./manifest.js";

export const dagboCore = createDepartmentCore();

for (const department of DEPARTMENTS) dagboCore.register(department);

// Expose a read-only integration point for the existing static pages.
// Department state deliberately remains "not-integrated" until its real
// engine and data checks are migrated and verified.
if (typeof window !== "undefined") {
  window.DAGBO_CORE = dagboCore;
  window.dispatchEvent(new CustomEvent("dagbo:departments-ready", {
    detail: { departments: dagboCore.list() }
  }));
}

import { createDepartmentCore } from "../core/department-core.js";
import { DEPARTMENTS } from "./manifest.js";
import { registerTradeEngine } from "./engines/trade.js";
import { registerIntelligenceEngine } from "./engines/intelligence.js";
import { registerQuantEngine } from "./engines/quant.js";
import { registerJournalEngine } from "./engines/journal.js";
import { registerAIEngine } from "./engines/ai.js";
import { registerAcademyEngine } from "./engines/academy.js";

export const dagboCore = createDepartmentCore();
for (const department of DEPARTMENTS) dagboCore.register(department);

// Each department owns its own module and public service interface. A module
// may call only its page-local adapter; interdepartment work goes through CORE
// events or an explicitly invoked public service, never private globals.
if (typeof window !== "undefined") {
  window.DAGBO_CORE = dagboCore;
  const env = { window, document };
  await Promise.all([
    registerTradeEngine(dagboCore, env.window, document),
    registerIntelligenceEngine(dagboCore, env.window, document),
    registerQuantEngine(dagboCore, env.window, document),
    registerJournalEngine(dagboCore, env.window, document),
    registerAIEngine(dagboCore, env.window, document),
    registerAcademyEngine(dagboCore, env.window, document)
  ]);
  window.dispatchEvent(new CustomEvent("dagbo:departments-ready", {
    detail: { departments: dagboCore.list(), health: dagboCore.healthSummary(), coreVersion: 3 }
  }));
}

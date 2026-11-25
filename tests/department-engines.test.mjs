import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const coreSource = await readFile(new URL("../src/core/department-core.js", import.meta.url), "utf8");
const { createDepartmentCore } = await import("data:text/javascript;base64," + Buffer.from(coreSource).toString("base64"));
const kitSource = await readFile(new URL("../src/departments/engine-kit.js", import.meta.url), "utf8");
const kitUrl = "data:text/javascript;base64," + Buffer.from(kitSource).toString("base64");
async function loadEngine(path, exportName) {
  let source = await readFile(new URL("../" + path, import.meta.url), "utf8");
  source = source.replace('../engine-kit.js', kitUrl);
  const mod = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  return mod[exportName];
}
const definitions = [
  ["trade", "src/departments/engines/trade.js", "registerTradeEngine"],
  ["intelligence", "src/departments/engines/intelligence.js", "registerIntelligenceEngine"],
  ["quant", "src/departments/engines/quant.js", "registerQuantEngine"],
  ["journal", "src/departments/engines/journal.js", "registerJournalEngine"],
  ["ai", "src/departments/engines/ai.js", "registerAIEngine"],
  ["academy", "src/departments/engines/academy.js", "registerAcademyEngine"]
];
function mockEnvironment(page = "index.html") {
  const values = new Map();
  const win = {
    location: { pathname: "/" + page },
    localStorage: { getItem: key => values.get(key) || null, setItem: (key,value) => values.set(key,value) },
    dispatchEvent() {},
    DagboStrategyProfiles: { getProfiles: () => [{ id: "scalping" }] }
  };
  const doc = {
    getElementById: () => null,
    querySelectorAll: () => []
  };
  return { win, doc };
}

test("all six departments register independent, namespaced service boundaries", async () => {
  const core = createDepartmentCore();
  for (const [id] of definitions) core.register({ id });
  const env = mockEnvironment();
  for (const [id, path, name] of definitions) {
    const register = await loadEngine(path, name);
    await register(core, env.win, env.doc);
    const status = await core.invoke(id, "status", {});
    assert.equal(status.department, id);
    assert.equal(status.boundary, "isolated");
    assert.ok(core.get(id).state === "ready");
  }
  const probes = {
    trade: ["signalSnapshots", {}],
    intelligence: ["marketContext", {}],
    quant: ["profiles", {}],
    journal: ["trades", {}],
    ai: ["status", {}],
    academy: ["status", {}]
  };
  for (const [id, [service, input]] of Object.entries(probes)) {
    const result = await core.invoke(id, service, input);
    assert.ok(result && typeof result === "object", id + " must expose its own public service");
  }
  assert.equal(core.list().length, 6);
  assert.equal(core.healthSummary().ready, 6);
});

test("department services refuse to operate another department's page", async () => {
  const core = createDepartmentCore();
  for (const [id] of definitions) core.register({ id });
  const env = mockEnvironment("journal.html");
  for (const [id, path, name] of definitions) {
    const register = await loadEngine(path, name);
    await register(core, env.win, env.doc);
  }
  const trade = await core.invoke("trade", "refreshSignals", {});
  const ai = await core.invoke("ai", "ask", { message: "Explain risk management" });
  assert.equal(trade.available, false);
  assert.equal(trade.page, "journal.html");
  assert.equal(ai.available, false);
  assert.equal(ai.page, "journal.html");
  const journal = await core.invoke("journal", "trades", {});
  assert.deepEqual(journal, []);
});

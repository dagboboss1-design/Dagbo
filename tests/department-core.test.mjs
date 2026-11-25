import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/core/department-core.js", import.meta.url), "utf8");
const coreModule = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const { createDepartmentCore } = coreModule;

test("registers departments with safe default state", () => {
  const core = createDepartmentCore();
  const item = core.register({ id: "trade", name: "DAGBO TRADE", routes: ["signals.html"] });
  assert.equal(item.id, "trade");
  assert.equal(item.state, "not-integrated");
  assert.deepEqual(item.routes, ["signals.html"]);
  assert.equal(core.get("trade"), item);
});

test("rejects invalid and duplicate department identifiers", () => {
  const core = createDepartmentCore();
  assert.throws(() => core.register({ id: "Bad ID" }), /valid id/);
  core.register({ id: "trade" });
  assert.throws(() => core.register({ id: "trade" }), /already registered/);
});

test("publishes namespaced events and supports unsubscribe", () => {
  const core = createDepartmentCore();
  core.register({ id: "trade", routes: ["signals.html"] });
  const received = [];
  const unsubscribe = core.subscribe("trade:signal", payload => received.push(payload));
  core.publish("trade:signal", { symbol: "XAUUSD" });
  unsubscribe();
  core.publish("trade:signal", { symbol: "EURUSD" });
  assert.equal(received.length, 1);
  assert.equal(received[0].symbol, "XAUUSD");
  assert.ok(received[0].emittedAt);
  assert.ok(Object.isFrozen(received[0]));
});

test("rejects invalid event names and invalid health states", () => {
  const core = createDepartmentCore();
  core.register({ id: "trade" });
  assert.throws(() => core.publish("invalid", {}), /department:event/);
  assert.throws(() => core.updateHealth("trade", "unknown"), /Invalid department state/);
});

test("updates health without allowing unknown departments", () => {
  const core = createDepartmentCore();
  core.register({ id: "trade" });
  const updated = core.updateHealth("trade", "degraded", [
    { name: "market-data", state: "unavailable", detail: "Provider timeout" }
  ]);
  assert.equal(updated.state, "degraded");
  assert.equal(updated.checks[0].state, "unavailable");
  assert.equal(core.get("trade").state, "degraded");
  assert.throws(() => core.updateHealth("missing", "ready"), /Unknown department/);
});


test("enforces exclusive route ownership and department service isolation", async () => {
  const core = createDepartmentCore();
  core.register({ id: "trade", routes: ["signals.html"] });
  core.register({ id: "journal", routes: ["journal.html"] });
  assert.throws(() => core.register({ id: "other", routes: ["signals.html"] }), /already belongs/);
  core.registerService("trade", "scan", async input => ({ pair: input.pair, owner: "trade" }));
  assert.deepEqual(await core.invoke("trade", "scan", { pair: "XAUUSD" }), { pair: "XAUUSD", owner: "trade" });
  await assert.rejects(() => core.invoke("journal", "scan", {}), /Unknown service/);
});

test("runs health checks and records degraded dependencies without hiding failures", async () => {
  const core = createDepartmentCore();
  core.register({ id: "trade" });
  const result = await core.runHealthChecks("trade", [
    { name: "runtime", run: async () => true },
    { name: "market-data", run: async () => { throw new Error("provider timeout"); } }
  ]);
  assert.equal(result.state, "degraded");
  assert.equal(result.checks[0].state, "ready");
  assert.equal(result.checks[1].state, "unavailable");
  assert.match(result.checks[1].detail, /provider timeout/);
});


test("summarizes all department health states", () => {
  const core = createDepartmentCore();
  core.register({ id: "trade" });
  core.register({ id: "journal" });
  assert.deepEqual(core.healthSummary(), {
    total: 2, ready: 0, degraded: 0, unavailable: 0, notIntegrated: 2, overall: "degraded"
  });
  core.updateHealth("trade", "ready", [{ name: "runtime", state: "ready" }]);
  core.updateHealth("journal", "unavailable", [{ name: "storage", state: "unavailable" }]);
  assert.equal(core.healthSummary().overall, "unavailable");
  assert.equal(core.healthSummary().ready, 1);
  assert.equal(core.healthSummary().unavailable, 1);
});

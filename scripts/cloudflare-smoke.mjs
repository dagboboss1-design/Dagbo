const base = "http://127.0.0.1:8787";

async function get(path, expectedStatus, check) {
  const options = path.startsWith("/api/cron-") || path === "/api/news-monitor" ? { headers: { Authorization: "Bearer xxxxxxxxxxxxxxxxx" } } : undefined;
  const response = await fetch(base + path, options);
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(path + ": expected HTTP " + expectedStatus + ", received " + response.status + ": " + body.slice(0, 300));
  }
  if (check) check(response, body);
  console.log("PASS", response.status, path);
}

let ready = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await fetch(base + "/api/health");
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready) throw new Error("Cloudflare Worker did not start on port 8787");

await get("/", 200, (_response, body) => {
  if (!/<!doctype html|<html/i.test(body)) throw new Error("Homepage did not return HTML");
});
await get("/api/health", 200, (_response, body) => {
  const data = JSON.parse(body);
  if (data.success !== true || !data.services || data.services.cronSecret !== true) throw new Error("Health endpoint returned an invalid response or did not read the test secret from process.env");
});
await get("/api/cron-scan", 401);
await get("/api/cron-signal", 401);
await get("/api/cron-signals", 401);
await get("/api/news-monitor", 401);
await get("/api/trades", 405);
await get("/api/push?action=public-key", 503);
await get("/api/not-a-real-route", 404);
await get("/api/cron-scan.js", 404);
await get("/lib/push-adapter.js", 404);
await get("/package.json", 404);
console.log("Cloudflare runtime smoke tests passed.");

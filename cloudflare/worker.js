import calendar from "../api/calendar.js";
import chart from "../api/chart.js";
import cronScan from "../api/cron-scan.js";
import cronSignal from "../api/cron-signal.js";
import cronSignals from "../api/cron-signals.js";
import exchangeRate from "../api/exchange-rate.js";
import fundamentals from "../api/fundamentals.js";
import health from "../api/health.js";
import marketData from "../api/market-data.js";
import newsMonitor from "../api/news-monitor.js";
import newsSignal from "../api/news-signal.js";
import push from "../api/push.js";
import replay from "../api/replay.js";
import trades from "../api/trades.js";

const routes = new Map([
  ["/api/calendar", calendar],
  ["/api/chart", chart],
  ["/api/cron-scan", cronScan],
  ["/api/cron-signal", cronSignal],
  ["/api/cron-signals", cronSignals],
  ["/api/exchange-rate", exchangeRate],
  ["/api/fundamentals", fundamentals],
  ["/api/health", health],
  ["/api/market-data", marketData],
  ["/api/news-monitor", newsMonitor],
  ["/api/news-signal", newsSignal],
  ["/api/push", push],
  ["/api/replay", replay],
  ["/api/trades", trades]
]);

function queryObject(url) {
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else query[key] = value;
  }
  return query;
}

function createResponseBridge() {
  let statusCode = 200;
  const headers = new Headers();
  let response = null;

  const finish = (body, contentType) => {
    if (contentType && !headers.has("content-type")) headers.set("content-type", contentType);
    response = new Response(body, { status: statusCode, headers });
    return response;
  };

  const res = {
    get statusCode() { return statusCode; },
    set statusCode(value) { statusCode = Number(value) || 200; },
    get headersSent() { return response !== null; },
    status(code) { statusCode = Number(code) || 200; return res; },
    setHeader(name, value) { headers.set(name, Array.isArray(value) ? value.join(", ") : String(value)); return res; },
    getHeader(name) { return headers.get(name); },
    json(value) { return finish(JSON.stringify(value), "application/json; charset=utf-8"); },
    send(value) {
      if (value !== null && typeof value === "object" && !(value instanceof ArrayBuffer)) {
        return res.json(value);
      }
      return finish(value == null ? null : String(value), "text/plain; charset=utf-8");
    },
    end(value) { return finish(value == null ? null : String(value)); },
    redirect(codeOrUrl, maybeUrl) {
      const code = typeof maybeUrl === "string" ? codeOrUrl : 302;
      const target = typeof maybeUrl === "string" ? maybeUrl : codeOrUrl;
      statusCode = Number(code) || 302;
      headers.set("location", String(target));
      return finish(null);
    },
    getResponse() { return response; }
  };
  return res;
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const routePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  const handler = routes.get(routePath);
  if (!handler) return Response.json({ error: "API route not found" }, { status: 404 });

  const headers = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.text();
    if (raw) {
      const type = request.headers.get("content-type") || "";
      if (type.includes("application/json")) {
        try { body = JSON.parse(raw); }
        catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
      } else body = raw;
    }
  }

  const req = {
    method: request.method,
    url: request.url,
    headers,
    query: queryObject(url),
    body,
    env,
    context: ctx
  };
  const res = createResponseBridge();

  try {
    const returned = await handler(req, res);
    if (returned instanceof Response) return returned;
    return res.getResponse() || Response.json({ error: "API handler did not return a response" }, { status: 500 });
  } catch (error) {
    console.error("DAGBO Cloudflare API error:", url.pathname, error?.stack || error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  }
};

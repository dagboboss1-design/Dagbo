const BASE = "https://api-v4.fcsapi.com/forex/economy_cal";
const FMP_BASE = "https://financialmodelingprep.com/stable/economic-calendar";
const FOREX_FACTORY_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FOREX_FACTORY_CACHE_KEY = "dagbo:news:forexfactory:weekly:v1";
const FOREX_FACTORY_CACHE_SECONDS = 55 * 60;
let memoryCalendarCache = null;

function utcDate(date) { return date.toISOString().slice(0, 10); }
function parseDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return new Date(NaN);
  return new Date(raw.replace(" ", "T") + (/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? "" : "Z"));
}
function normalizeFcs(row) {
  const date = parseDate(row.date);
  const importance = Number(row.importance);
  return {
    id: String(row.id || row.event || ""),
    eventCode: String(row.event || ""),
    title: String(row.title || row.indicator || "Economic event"),
    name: String(row.title || row.indicator || "Economic event"),
    currency: String(row.currency || "GLOBAL").toUpperCase(),
    country: String(row.country || ""),
    impact: importance >= 2 ? "High" : importance === 1 ? "Medium" : "Low",
    importance, date,
    actual: row.actual == null ? "" : String(row.actual),
    forecast: row.forecast == null ? "" : String(row.forecast),
    previous: row.previous == null ? "" : String(row.previous),
    source: "FCS API",
    unit: String(row.unit || ""),
    period: String(row.period || ""),
    sourceUrl: String(row.source_url || "")
  };
}
function normalizeFmp(row) {
  const date = parseDate(row.date);
  return {
    id: "fmp-" + [row.event, row.currency, row.date].join("-"),
    eventCode: String(row.event || ""),
    title: String(row.event || "Economic event"),
    name: String(row.event || "Economic event"),
    currency: String(row.currency || "GLOBAL").toUpperCase(),
    country: String(row.country || ""),
    impact: String(row.impact || "Low"),
    importance: String(row.impact || "").toLowerCase() === "high" ? 2 :
      (String(row.impact || "").toLowerCase() === "medium" ? 1 : 0),
    date,
    actual: row.actual == null ? "" : String(row.actual),
    forecast: row.estimate == null ? (row.forecast == null ? "" : String(row.forecast)) : String(row.estimate),
    previous: row.previous == null ? "" : String(row.previous),
    source: "FMP Backup",
    unit: String(row.unit || ""),
    period: "",
    sourceUrl: "https://site.financialmodelingprep.com/developer/docs/stable/economics-calendar"
  };
}
function normalizeForexFactory(row) {
  const date = parseDate(row.date);
  const impact = String(row.impact || "Low");
  const importance = impact.toLowerCase() === "high" ? 2 :
    impact.toLowerCase() === "medium" ? 1 : 0;
  const currency = String(row.country || "GLOBAL").toUpperCase();
  const title = String(row.title || "Economic event");
  const dateKey = Number.isFinite(date.getTime()) ? date.toISOString() : String(row.date || "unknown");
  return {
    id: "ff-" + [title, currency, dateKey].join("-"),
    eventCode: "",
    title,
    name: title,
    currency,
    country: currency,
    impact,
    importance,
    date,
    actual: row.actual == null ? "" : String(row.actual),
    forecast: row.forecast == null ? "" : String(row.forecast),
    previous: row.previous == null ? "" : String(row.previous),
    source: "Forex Factory · cached fallback",
    unit: "",
    period: "",
    sourceUrl: "https://www.forexfactory.com/calendar"
  };
}
function withinRange(events, from, to) {
  const start = Date.parse(String(from) + "T00:00:00Z");
  const end = Date.parse(String(to) + "T23:59:59.999Z");
  return events.filter(event => {
    const stamp = event.date instanceof Date ? event.date.getTime() : Date.parse(event.date);
    return Number.isFinite(stamp) && stamp >= start && stamp <= end;
  }).sort((a,b) => a.date - b.date);
}
function reviveCachedCalendar(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map(row => Object.assign({}, row, { date: parseDate(row.date) }))
    .filter(row => Number.isFinite(row.date.getTime()));
}
async function readForexFactoryCache() {
  if (memoryCalendarCache && memoryCalendarCache.expiresAt > Date.now()) {
    return memoryCalendarCache.events;
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const { Redis } = require("@upstash/redis");
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    const raw = await redis.get(FOREX_FACTORY_CACHE_KEY);
    if (!raw) return null;
    const events = reviveCachedCalendar(typeof raw === "string" ? JSON.parse(raw) : raw);
    memoryCalendarCache = { events, expiresAt: Date.now() + 60 * 1000 };
    return events;
  } catch (error) {
    console.warn("DAGBO Forex Factory calendar cache read failed:", error.message);
    return null;
  }
}
async function writeForexFactoryCache(events) {
  memoryCalendarCache = { events, expiresAt: Date.now() + FOREX_FACTORY_CACHE_SECONDS * 1000 };
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return;
  try {
    const { Redis } = require("@upstash/redis");
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.set(FOREX_FACTORY_CACHE_KEY, JSON.stringify(events), { ex: FOREX_FACTORY_CACHE_SECONDS });
  } catch (error) {
    console.warn("DAGBO Forex Factory calendar cache write failed:", error.message);
  }
}
async function fetchForexFactoryFallback(from, to, providerFailures) {
  const cached = await readForexFactoryCache();
  if (cached) return withinRange(cached, from, to);
  const response = await fetch(FOREX_FACTORY_URL, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(6500)
  });
  if (!response.ok) throw new Error("Forex Factory calendar HTTP " + response.status);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.includes("json")) {
    throw new Error("Forex Factory calendar returned a non-JSON response");
  }
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Forex Factory calendar returned an invalid event list");
  const events = data.map(normalizeForexFactory)
    .filter(event => Number.isFinite(event.date.getTime()))
    .sort((a,b) => a.date - b.date);
  await writeForexFactoryCache(events);
  console.warn("DAGBO economic calendar using cached Forex Factory fallback:", providerFailures);
  return withinRange(events, from, to);
}
async function fetchFcsCalendarEvents(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const from = options.from || utcDate(now);
  const to = options.to || utcDate(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
  const key = process.env.FCS_API_KEY || process.env.FCS_ACCESS_KEY || process.env.FCS_API_ACCESS_KEY || process.env.FCSAPI_ACCESS_KEY;
  let primaryError = null;
  if (key) {
    try {
      const url = BASE + "?importance=1,2&from=" + encodeURIComponent(from) +
        "&to=" + encodeURIComponent(to) + "&access_key=" + encodeURIComponent(key);
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6500) });
      let data = {};
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) throw new Error("FCS calendar HTTP " + response.status);
      if (data && Number(data.code) === 112) return [];
      if (data.status !== true || Number(data.code) !== 200 || !Array.isArray(data.response)) {
        throw new Error("FCS calendar unavailable: " + String(data.msg || "Invalid FCS response"));
      }
      return data.response.map(normalizeFcs).filter(e => Number.isFinite(e.date.getTime())).sort((a,b)=>a.date-b.date);
    } catch (error) { primaryError = error; }
  } else primaryError = new Error("FCS access key is not configured");

  const fmpKey = process.env.FMP_API_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY || process.env.FMP_ACCESS_KEY || process.env.FMP_KEY;
  let fmpError = null;
  if (fmpKey) {
    try {
      const url = FMP_BASE + "?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to) +
        "&apikey=" + encodeURIComponent(fmpKey);
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(7000) });
      let data = {};
      try { data = await response.json(); } catch (_) {}
      if (!response.ok || !Array.isArray(data) || data.Error || data["Error Message"]) {
        const detail = data && (data["Error Message"] || data.message || data.Error);
        throw new Error("FMP calendar unavailable: " + String(detail || ("HTTP " + response.status)) + ". Check FMP plan entitlement.");
      }
      return data.map(normalizeFmp).filter(e => Number.isFinite(e.date.getTime()))
        .sort((a,b)=>a.date-b.date);
    } catch (error) { fmpError = error; }
  } else fmpError = new Error("FMP_API_KEY is not configured");

  const failures = "FCS: " + primaryError.message + "; FMP: " + fmpError.message;
  try {
    return await fetchForexFactoryFallback(from, to, failures);
  } catch (fallbackError) {
    throw new Error(failures + "; Forex Factory fallback unavailable: " + fallbackError.message);
  }
}
module.exports = { fetchFcsCalendarEvents };

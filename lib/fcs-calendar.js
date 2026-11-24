const BASE = "https://api-v4.fcsapi.com/forex/economy_cal";
const FMP_BASE = "https://financialmodelingprep.com/stable/economic-calendar";

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
  if (!fmpKey) throw new Error("FCS calendar failed (" + primaryError.message + "); FMP_API_KEY is not configured");
  const url = FMP_BASE + "?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to) +
    "&apikey=" + encodeURIComponent(fmpKey);
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(7000) });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok || !Array.isArray(data) || data.Error || data["Error Message"]) {
    const detail = data && (data["Error Message"] || data.message || data.Error);
    throw new Error("FCS failed (" + primaryError.message + "); FMP calendar unavailable: " +
      String(detail || ("HTTP " + response.status)) + ". Check FMP plan entitlement.");
  }
  return data.map(normalizeFmp).filter(e => Number.isFinite(e.date.getTime()))
    .sort((a,b)=>a.date-b.date);
}
module.exports = { fetchFcsCalendarEvents };

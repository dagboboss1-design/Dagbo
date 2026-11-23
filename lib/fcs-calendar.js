const BASE = "https://api-v4.fcsapi.com/forex/economy_cal";

function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchFcsCalendarEvents(options = {}) {
  const key = process.env.FCS_API_KEY;
  if (!key) throw new Error("FCS_API_KEY is not configured");

  const now = options.now instanceof Date ? options.now : new Date();
  const from = options.from || utcDate(now);
  const toDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const to = options.to || utcDate(toDate);
  const url = BASE + "?importance=1,2&from=" + encodeURIComponent(from) +
    "&to=" + encodeURIComponent(to) + "&access_key=" + encodeURIComponent(key);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(7000)
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error("FCS calendar HTTP " + response.status);
  if (data && Number(data.code) === 112) return [];
  if (data.status !== true || Number(data.code) !== 200 || !Array.isArray(data.response)) {
    throw new Error("FCS calendar unavailable: " + String(data.msg || "Invalid FCS response"));
  }

  return data.response.map(row => {
    const rawDate = String(row.date || "").trim();
    const date = new Date(rawDate.replace(" ", "T") + (/[zZ]|[+-]\d\d:\d\d$/.test(rawDate) ? "" : "Z"));
    const importance = Number(row.importance);
    return {
      id: String(row.id || row.event || ""),
      eventCode: String(row.event || ""),
      title: String(row.title || row.indicator || "Economic event"),
      name: String(row.title || row.indicator || "Economic event"),
      currency: String(row.currency || "GLOBAL").toUpperCase(),
      country: String(row.country || ""),
      impact: importance >= 2 ? "High" : importance === 1 ? "Medium" : "Low",
      importance,
      date,
      actual: row.actual == null ? "" : String(row.actual),
      forecast: row.forecast == null ? "" : String(row.forecast),
      previous: row.previous == null ? "" : String(row.previous),
      source: String(row.source || ""),
      unit: String(row.unit || ""),
      period: String(row.period || ""),
      sourceUrl: String(row.source_url || "")
    };
  }).filter(event => Number.isFinite(event.date.getTime()))
    .sort((a, b) => a.date - b.date);
}

module.exports = { fetchFcsCalendarEvents };

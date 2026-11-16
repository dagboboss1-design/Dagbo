const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

function inWindow(events) {
  const now = Date.now();
  return events.filter(event => !Number.isNaN(event.date.getTime()) &&
    event.date.getTime() >= now - 30 * 60 * 1000 &&
    event.date.getTime() <= now + 7 * 24 * 60 * 60 * 1000
  ).sort((a,b) => a.date - b.date);
}

async function fetchFmpCalendar(apiKey) {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = "https://financialmodelingprep.com/stable/economic-calendar?from=" +
    from + "&to=" + to + "&apikey=" + encodeURIComponent(apiKey);
  const response = await fetch(url);
  const rows = await response.json();
  if (!response.ok || !Array.isArray(rows)) throw new Error("FMP economic calendar unavailable");
  return inWindow(rows.map(row => ({
    name: String(row.event || "Economic event"),
    currency: String(row.currency || row.country || "GLOBAL").toUpperCase(),
    impact: String(row.impact || "Unknown"),
    date: new Date(String(row.date || "").replace(" ", "T") + (String(row.date || "").includes("Z") ? "" : "Z")),
    forecast: row.estimate == null ? "" : String(row.estimate),
    previous: row.previous == null ? "" : String(row.previous),
    actual: row.actual == null ? "" : String(row.actual)
  })));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });

  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    try {
      const events = await fetchFmpCalendar(fmpKey);
      return res.status(200).json({ success: true, source: "Financial Modeling Prep", fetchedAt: new Date().toISOString(), events });
    } catch (error) {
      console.error("DAGBO FMP calendar fallback:", error.message);
    }
  }

  try {
    const response = await fetch(CALENDAR_URL, { headers: { "User-Agent": "DAGBO-SIGNAL-Economic-Calendar/1.0" } });
    if (!response.ok) throw new Error("Economic calendar returned HTTP " + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Calendar response was not a list");
    const events = inWindow(rows.map(row => ({
      name: String(row.title || "Economic event"),
      currency: String(row.country || "GLOBAL").toUpperCase(),
      impact: String(row.impact || "Unknown"),
      date: new Date(row.date),
      forecast: row.forecast || "",
      previous: row.previous || "",
      actual: row.actual || ""
    })));
    return res.status(200).json({ success: true, source: "Forex Factory calendar feed", fetchedAt: new Date().toISOString(), events });
  } catch (error) {
    console.error("DAGBO calendar feed error:", error.message);
    return res.status(502).json({ success: false, error: "Economic calendar is temporarily unavailable" });
  }
};

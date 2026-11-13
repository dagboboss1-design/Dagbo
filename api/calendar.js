const CALENDAR_URL = "https://showmytrades.com/api/public/calendar/v1?currency=USD%2CEUR%2CGBP%2CJPY%2CAUD%2CNZD%2CCAD%2CCHF%2CCNY&impact=all&days=7";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=900, stale-while-revalidate=300");
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });
  try {
    const response = await fetch(CALENDAR_URL, {
      headers: { "User-Agent": "DAGBO-SIGNAL-Economic-Calendar/1.0", "Accept": "application/json" }
    });
    if (!response.ok) throw new Error("ShowMyTrades calendar returned HTTP " + response.status);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.events)) throw new Error("ShowMyTrades calendar response was invalid");
    const now = Date.now();
    const events = payload.events.map(row => {
      const timestamp = Number(row.ts);
      const date = row.time || (Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : "");
      return {
        id: String(row.id || ""),
        name: String(row.title || "Economic event").slice(0, 160),
        currency: String(row.currency || "GLOBAL").toUpperCase(),
        impact: String(row.impact || "unknown").toLowerCase(),
        date,
        timestamp: Number.isFinite(timestamp) ? timestamp : (Date.parse(date) / 1000 || null),
        forecast: row.forecast == null ? "" : String(row.forecast),
        previous: row.previous == null ? "" : String(row.previous),
        actual: row.actual == null ? "" : String(row.actual),
        status: String(row.status || "scheduled"),
        confidence: String(row.confidence || "not supplied"),
        period: String(row.period || ""),
        movedFrom: String(row.moved_from || "")
      };
    }).filter(event => {
      const time = Date.parse(event.date);
      return Number.isFinite(time) && time >= now - 6 * 60 * 60 * 1000 &&
        time <= now + 7 * 24 * 60 * 60 * 1000;
    }).sort((a,b) => Date.parse(a.date) - Date.parse(b.date));
    return res.status(200).json({
      success: true,
      source: "ShowMyTrades Economic Calendar",
      fetchedAt: new Date().toISOString(),
      serverTime: payload.server_time || null,
      events,
      attribution: {
        text: "Economic calendar by ShowMyTrades",
        url: "https://showmytrades.com/tools/economic-calendar"
      },
      docs: "https://showmytrades.com/docs/api/economic-calendar",
      note: "Calendar schedules and figures are supplied as published and may change. Verify major releases with the issuing central bank or statistics agency."
    });
  } catch (error) {
    console.error("DAGBO ShowMyTrades calendar error:", error.message);
    return res.status(502).json({ success: false, error: "ShowMyTrades economic calendar is temporarily unavailable" });
  }
};

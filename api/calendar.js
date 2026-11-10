const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });
  try {
    const response = await fetch(CALENDAR_URL, {
      headers: { "User-Agent": "DAGBO-SIGNAL-Economic-Calendar/1.0" }
    });
    if (!response.ok) throw new Error("Economic calendar returned HTTP " + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Calendar response was not a list");
    const now = Date.now();
    const events = rows.map(row => ({
      name: String(row.title || "Economic event"),
      currency: String(row.country || "GLOBAL").toUpperCase(),
      impact: String(row.impact || "Unknown"),
      date: new Date(row.date),
      forecast: row.forecast || "",
      previous: row.previous || "",
      actual: row.actual || ""
    })).filter(event =>
      !Number.isNaN(event.date.getTime()) &&
      event.date.getTime() >= now - 30 * 60 * 1000 &&
      event.date.getTime() <= now + 7 * 24 * 60 * 60 * 1000
    ).sort((a,b) => a.date - b.date);
    return res.status(200).json({
      success: true,
      source: "Forex Factory calendar feed",
      fetchedAt: new Date().toISOString(),
      events
    });
  } catch (error) {
    console.error("DAGBO calendar feed error:", error.message);
    return res.status(502).json({ success: false, error: "Economic calendar is temporarily unavailable" });
  }
};

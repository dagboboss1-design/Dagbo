const { fetchFcsCalendarEvents } = require("../lib/fcs-calendar");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });
  try {
    const events = await fetchFcsCalendarEvents();
    const now = Date.now();
    const visible = events.filter(event =>
      event.date.getTime() >= now - 30 * 60 * 1000 &&
      event.date.getTime() <= now + 7 * 24 * 60 * 60 * 1000
    ).map(event => ({
      id: event.id,
      eventCode: event.eventCode,
      name: event.name,
      currency: event.currency,
      country: event.country,
      impact: event.impact,
      date: event.date.toISOString(),
      forecast: event.forecast,
      previous: event.previous,
      actual: event.actual,
      source: event.source,
      unit: event.unit,
      period: event.period,
      sourceUrl: event.sourceUrl
    }));
    return res.status(200).json({
      success: true,
      source: "FCS Economic Calendar",
      fetchedAt: new Date().toISOString(),
      events: visible
    });
  } catch (error) {
    console.error("DAGBO FCS calendar error:", error.message);
    return res.status(502).json({
      success: false,
      error: "FCS economic calendar is unavailable. Check the FCS plan and API key.",
      detail: String(error.message || error)
    });
  }
};

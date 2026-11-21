const WINDOWS = [
  { id: "sydney", name: "Sydney", timezone: "Australia/Sydney", start: 8, end: 17 },
  { id: "tokyo", name: "Tokyo", timezone: "Asia/Tokyo", start: 9, end: 18 },
  { id: "london", name: "London", timezone: "Europe/London", start: 8, end: 17 },
  { id: "new-york", name: "New York", timezone: "America/New_York", start: 8, end: 17 }
];

function clockAt(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const weekday = values.weekday;
  return {
    localTime: `${values.hour}:${values.minute}:${values.second}`,
    localDate: `${values.year}-${values.month}-${values.day}`,
    weekday,
    minuteOfDay: hour * 60 + minute,
    isWeekday: !["Sat", "Sun"].includes(weekday)
  };
}

module.exports = function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const now = new Date();
  const lagos = clockAt(now, "Africa/Lagos");
  const sessions = WINDOWS.map(window => {
    const local = clockAt(now, window.timezone);
    const start = window.start * 60;
    const end = window.end * 60;
    const activeWindow = local.isWeekday && local.minuteOfDay >= start && local.minuteOfDay < end;
    const minutesToStart = (start - local.minuteOfDay + 1440) % 1440;
    const minutesToEnd = (end - local.minuteOfDay + 1440) % 1440;
    return {
      id: window.id, name: window.name, timezone: window.timezone,
      localTime: local.localTime, localDate: local.localDate,
      activeWindow, windowLabel: `${String(window.start).padStart(2,"0")}:00–${String(window.end).padStart(2,"0")}:00 local`,
      minutesToStart: activeWindow ? null : minutesToStart,
      minutesToEnd: activeWindow ? minutesToEnd : null
    };
  });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    success: true, generatedAt: now.toISOString(),
    userReference: { timezone: "Africa/Lagos", localTime: lagos.localTime, localDate: lagos.localDate },
    sessions,
    methodology: "Regional FX activity windows, not exchange-open confirmation. Daylight-saving changes are handled by IANA time zones. Exchange holidays, broker-specific CFD hours and provider outages require separate live calendar/feed checks."
  });
};

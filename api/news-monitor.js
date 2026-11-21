const { runNewsMonitor, validAuth } = require("../lib/news-monitor");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Public readiness-only check: never exposes secrets or runs the scheduled scan.
  if (req.method === "GET" && req.query && req.query.health === "1") {
    return res.status(200).json({
      success: true,
      services: {
        redis: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
        vapid: !!(process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
        marketData: !!(process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_API_KEY_2 || process.env.NEWS_SPIKE_TWELVE_DATA_API_KEY),
        cronSecret: !!(process.env.DAGBO_CRON_SECRET || process.env.CRON_SECRET || process.env.SIGNAL_PUSH_SECURITY || process.env.Signal_push_security || process.env.SIGNAL_PUSH_SECRET)
      }
    });
  }
  if (!validAuth(req)) return res.status(401).json({ error: "Unauthorized news monitor" });
  try {
    const result = await runNewsMonitor();
    return res.status(200).json(result);
  } catch (error) {
    console.error("DAGBO NEWS MONITOR FAILED:", error);
    return res.status(502).json({ error: "News monitor failed", detail: error.message });
  }
};

const { runNewsMonitor, validAuth } = require("../lib/news-monitor");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
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

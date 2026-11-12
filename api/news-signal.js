const { Redis } = require("@upstash/redis");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return res.status(503).json({ error: "News signal storage is not configured" });

  try {
    const redis = new Redis({ url, token });
    const raw = await redis.get("dagbo:news:signal:latest");
    if (!raw) return res.status(200).json({ success: true, candidate: null });
    const candidate = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!candidate || !candidate.expiresAt || Date.now() >= new Date(candidate.expiresAt).getTime()) {
      return res.status(200).json({ success: true, candidate: null });
    }
    return res.status(200).json({ success: true, candidate });
  } catch (error) {
    console.error("DAGBO news signal read error:", error.message);
    return res.status(502).json({ error: "Could not load the latest news context" });
  }
};

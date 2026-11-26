const { Redis } = require("@upstash/redis");

const PAIRS = ["GBPUSD", "GBPJPY", "EURUSD", "XAUUSD"];

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return res.status(503).json({ error: "News signal storage is not configured" });

  try {
    const redis = new Redis({ url, token });
    const stored = await Promise.all(PAIRS.map(async pair => {
      const raw = await redis.get("dagbo:news:signal:latest:" + pair);
      if (!raw) return null;
      const candidate = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!candidate || !candidate.expiresAt || Date.now() >= new Date(candidate.expiresAt).getTime()) return null;
      return candidate;
    }));
    const candidates = stored.filter(Boolean).sort((a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    // Backward compatibility for any candidate written by an older deployment.
    if (!candidates.length) {
      const raw = await redis.get("dagbo:news:signal:latest");
      if (raw) {
        const legacy = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (legacy && legacy.expiresAt && Date.now() < new Date(legacy.expiresAt).getTime()) candidates.push(legacy);
      }
    }
    return res.status(200).json({ success: true, candidate: candidates[0] || null, candidates });
  } catch (error) {
    console.error("DAGBO news signal read error:", error.message);
    return res.status(502).json({ error: "Could not load the latest news context" });
  }
};

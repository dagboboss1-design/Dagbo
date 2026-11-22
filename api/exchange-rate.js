let cachedRate = null;
const CACHE_MS = 10 * 60 * 1000;
const MAX_STALE_MS = 30 * 60 * 1000;

module.exports = async function(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
  const now = Date.now();
  if (cachedRate && now - cachedRate.savedAt <= CACHE_MS) {
    return res.status(200).json({ ...cachedRate.payload, cached: true });
  }

  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) {
    if (cachedRate && now - cachedRate.savedAt <= MAX_STALE_MS) {
      return res.status(200).json({ ...cachedRate.payload, cached: true, stale: true });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "Live FX rate unavailable: TWELVE_DATA_API_KEY is not configured" });
  }

  try {
    const url = "https://api.twelvedata.com/exchange_rate?symbol=USD%2FNGN&dp=6&apikey=" + encodeURIComponent(key);
    const response = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    const rate = Number(data && data.rate);
    if (!response.ok || data.status === "error" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(data && data.message ? data.message : "No valid USD/NGN rate returned");
    }
    const timestamp = Number(data.timestamp) || Math.floor(now / 1000);
    const payload = {
      base: "USD", quote: "NGN", usdNgn: rate, timestamp,
      updatedAt: new Date(timestamp * 1000).toISOString(), provider: "Twelve Data"
    };
    cachedRate = { savedAt: now, payload };
    return res.status(200).json(payload);
  } catch (error) {
    console.error("DAGBO live USD/NGN lookup failed:", error.message);
    if (cachedRate && now - cachedRate.savedAt <= MAX_STALE_MS) {
      return res.status(200).json({ ...cachedRate.payload, cached: true, stale: true });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Live USD/NGN rate is temporarily unavailable" });
  }
};

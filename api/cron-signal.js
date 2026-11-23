const { Redis } = require("@upstash/redis");
const crypto = require("crypto");
const runScanner = require("./cron-scan");
const runNewsMonitor = require("./news-monitor");

let redisClient;
function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis is not configured");
  if (!redisClient) redisClient = new Redis({ url, token });
  return redisClient;
}
const redis = new Proxy({}, {
  get(_target, property) {
    const client = getRedis();
    const value = client[property];
    return typeof value === "function" ? value.bind(client) : value;
  }
});

function authorized(req) {
  const secrets = [
    process.env.DAGBO_CRON_SECRET,
    process.env.CRON_SECRET,
    process.env.SIGNAL_PUSH_SECURITY,
    process.env.Signal_push_security,
    process.env.SIGNAL_PUSH_SECRET
  ].filter(value => typeof value === "string" && value.length > 0);
  const headers = req.headers || {};
  const auth = String(headers.authorization || "").trim();
  const candidates = [
    auth.replace(/^Bearer\s+/i, "").trim(),
    headers["x-dagbo-cron-secret"],
    headers["x-cron-secret"]
  ].filter(value => typeof value === "string" && value.trim());
  return candidates.some(value => secrets.some(secret => {
    const a = Buffer.from(String(value).trim());
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }));
}

function invoke(handler, req) {
  let statusCode = 200;
  let payload = null;
  const response = {
    setHeader() { return this; },
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
    end(value) { payload = value || payload; return this; }
  };
  return Promise.resolve(handler(req, response)).then(() => ({
    status: statusCode,
    result: payload
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!authorized(req)) {
    console.warn("DAGBO cron dispatcher rejected: missing or invalid Authorization header");
    return res.status(401).json({
      success: false,
      error: "Unauthorized. Configure Authorization: Bearer <cron secret> in Cron-job.org."
    });
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).json({ success: false, error: "Upstash Redis is not configured" });
  }

  // All legacy Cron-job.org entries still point at /api/cron-signal.
  // Run both current workers from that one compatibility endpoint, while
  // preventing five near-simultaneous schedules from launching duplicate scans.
  const lockKey = "dagbo:cron:dispatcher:lock";
  try {
    const acquired = await redis.set(lockKey, String(Date.now()), { nx: true, ex: 240 });
    if (acquired !== "OK") {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: "DAGBO scan and news monitor are already running."
      });
    }

    const [scanner, news] = await Promise.all([
      invoke(runScanner, req),
      invoke(runNewsMonitor, req)
    ]);
    const success = scanner.status >= 200 && scanner.status < 300 &&
      news.status >= 200 && news.status < 300;
    const response = {
      success,
      checkedAt: new Date().toISOString(),
      scanner,
      newsMonitor: news
    };
    if (!success) {
      console.error("DAGBO cron dispatcher worker failure:", JSON.stringify(response));
      return res.status(502).json(response);
    }
    return res.status(200).json(response);
  } catch (error) {
    console.error("DAGBO cron dispatcher failed:", error);
    return res.status(502).json({
      success: false,
      error: "DAGBO scheduled workers failed",
      detail: String(error.message || error)
    });
  } finally {
    try { await redis.del(lockKey); } catch (error) {
      console.error("DAGBO cron dispatcher lock cleanup failed:", error.message);
    }
  }
};

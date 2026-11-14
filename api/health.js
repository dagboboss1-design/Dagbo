const webpush = require("../lib/push-adapter.js");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });
  const env = req.env || (typeof process !== "undefined" ? process.env : {});
  const checks = {
    ai: !!env.GROQ_API_KEY,
    pushPublicKey: !!env.VAPID_PUBLIC_KEY,
    pushPrivateKey: !!env.VAPID_PRIVATE_KEY,
    pushSubject: !!env.VAPID_SUBJECT,
    pushStorage: !!(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN),
    marketData: !!env.TWELVE_DATA_API_KEY,
    cronSecret: !!(env.DAGBO_CRON_SECRET || env.CRON_SECRET || env.SIGNAL_PUSH_SECURITY || env.SIGNAL_PUSH_SECRET)
  };
  if (req.query && req.query.check === "push-runtime") {
    try {
      await webpush.checkRuntime();
      checks.pushRuntime = true;
    } catch (error) {
      checks.pushRuntime = false;
      console.error("DAGBO push runtime check failed:", error.message);
    }
  }
  return res.status(200).json({
    success: true,
    services: checks,
    ready: {
      ai: checks.ai,
      push: checks.pushPublicKey && checks.pushPrivateKey && checks.pushSubject && checks.pushStorage,
      scanner: checks.marketData && checks.pushPublicKey && checks.pushPrivateKey && checks.pushSubject && checks.pushStorage && checks.cronSecret
    },
    note: "This endpoint reports whether required environment variables exist. It does not test third-party API calls or scheduled job execution."
  });
};

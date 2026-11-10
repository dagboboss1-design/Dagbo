const webpush = require("web-push");
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const SUBSCRIPTIONS = "dagbo:push:subscriptions";

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Push storage is not configured");
  return new Redis({ url, token });
}

function configureVapid() {
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) throw new Error("VAPID keys are not configured");
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

function getId(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

function authorized(req) {
  const secret = process.env.SIGNAL_PUSH_SECRET;
  const supplied = req.headers.authorization || "";
  if (!secret) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from("Bearer " + secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validSubscription(sub) {
  return !!(sub && typeof sub.endpoint === "string" &&
    sub.endpoint.startsWith("https://") && sub.keys &&
    typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const action = req.query && req.query.action;

  try {
    if (req.method === "GET" && action === "public-key") {
      if (!process.env.VAPID_PUBLIC_KEY) {
        return res.status(503).json({ error: "Push notifications are not configured on the server" });
      }
      return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
    }

    if (req.method === "POST" && action === "test") {
      const subscription = req.body;
      if (!validSubscription(subscription)) return res.status(400).json({ error: "Invalid subscription" });
      configureVapid();
      await webpush.sendNotification(subscription, JSON.stringify({
        title: "DAGBO SIGNAL — Test",
        body: "Your push notifications are working.",
        url: "/settings.html"
      }), { TTL: 60, urgency: "normal" });
      return res.status(200).json({ success: true, message: "Test notification sent to this device" });
    }

    if (req.method === "POST" && action === "subscribe") {
      const subscription = req.body;
      if (!validSubscription(subscription)) return res.status(400).json({ error: "Invalid subscription" });
      const redis = getRedis();
      const id = getId(subscription.endpoint);
      await redis.set("dagbo:push:sub:" + id, JSON.stringify(subscription));
      await redis.sadd(SUBSCRIPTIONS, id);
      return res.status(201).json({ success: true, message: "Notifications enabled" });
    }

    if (req.method === "POST" && action === "unsubscribe") {
      const endpoint = req.body && req.body.endpoint;
      if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
        return res.status(400).json({ error: "Invalid endpoint" });
      }
      const redis = getRedis();
      const id = getId(endpoint);
      await redis.del("dagbo:push:sub:" + id);
      await redis.srem(SUBSCRIPTIONS, id);
      return res.status(200).json({ success: true, message: "Notifications disabled" });
    }

    if (req.method === "POST" && action === "send") {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      const { pair, signal, entry, stopLoss, takeProfit } = req.body || {};
      const allowed = ["STRONG BUY", "WEAK BUY", "STRONG SELL", "WEAK SELL"];
      if (typeof pair !== "string" || !/^[A-Z0-9]{3,12}$/i.test(pair) ||
          typeof signal !== "string" || !allowed.includes(signal.toUpperCase())) {
        return res.status(400).json({ error: "Invalid pair or signal" });
      }

      configureVapid();
      const redis = getRedis();
      const ids = await redis.smembers(SUBSCRIPTIONS);
      let sent = 0, failed = 0, removed = 0;

      for (const id of ids) {
        const key = "dagbo:push:sub:" + id;
        try {
          const stored = await redis.get(key);
          if (!stored) { await redis.srem(SUBSCRIPTIONS, id); continue; }
          const sub = typeof stored === "string" ? JSON.parse(stored) : stored;
          await webpush.sendNotification(sub, JSON.stringify({
            title: "DAGBO SIGNAL — " + pair,
            body: signal.toUpperCase() + " signal detected for " + pair + ".",
            pair, signal: signal.toUpperCase(),
            entry: entry == null ? null : entry,
            stopLoss: stopLoss == null ? null : stopLoss,
            takeProfit: takeProfit == null ? null : takeProfit,
            url: "/signals.html"
          }), { TTL: 60, urgency: "high", topic: "dagbo-" + pair });
          sent++;
        } catch (error) {
          failed++;
          if ([404, 410].includes(error.statusCode)) {
            await redis.del(key);
            await redis.srem(SUBSCRIPTIONS, id);
            removed++;
          } else {
            console.error("DAGBO push delivery error:", error.message);
          }
        }
      }
      return res.status(200).json({ success: true, total: ids.length, sent, failed, removed });
    }

    return res.status(404).json({ error: "Unknown push action" });
  } catch (error) {
    console.error("DAGBO PUSH ERROR:", error.message);
    return res.status(500).json({ error: error.message || "Push service failed" });
  }
};

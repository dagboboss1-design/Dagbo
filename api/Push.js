const webpush = require("web-push");
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const SUBSCRIPTIONS = "dagbo:push:subscriptions";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function getId(endpoint) {
  return crypto
    .createHash("sha256")
    .update(endpoint)
    .digest("hex");
}

function authorized(req) {
  const supplied = req.headers.authorization || "";
  const expected = `Bearer ${process.env.SIGNAL_PUSH_SECRET || ""}`;

  if (!process.env.SIGNAL_PUSH_SECRET) return false;

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  return a.length === b.length &&
    crypto.timingSafeEqual(a, b);
}

function validSubscription(sub) {
  return sub &&
    typeof sub.endpoint === "string" &&
    sub.endpoint.startsWith("https://") &&
    sub.keys &&
    typeof sub.keys.p256dh === "string" &&
    typeof sub.keys.auth === "string";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    const action = req.query.action;

    // 1. GET PUBLIC VAPID KEY
    if (req.method === "GET" && action === "public-key") {
      return res.status(200).json({
        publicKey: process.env.VAPID_PUBLIC_KEY
      });
    }

    // 2. SAVE SUBSCRIPTION
    if (req.method === "POST" && action === "subscribe") {
      const subscription = req.body;

      if (!validSubscription(subscription)) {
        return res.status(400).json({
          error: "Invalid subscription"
        });
      }

      const id = getId(subscription.endpoint);

      await redis.set(
        `dagbo:push:sub:${id}`,
        JSON.stringify(subscription)
      );

      await redis.sadd(SUBSCRIPTIONS, id);

      return res.status(201).json({
        success: true,
        message: "Notifications enabled"
      });
    }

    // 3. REMOVE SUBSCRIPTION
    if (req.method === "POST" && action === "unsubscribe") {
      const endpoint = req.body?.endpoint;

      if (
        typeof endpoint !== "string" ||
        !endpoint.startsWith("https://")
      ) {
        return res.status(400).json({
          error: "Invalid endpoint"
        });
      }

      const id = getId(endpoint);

      await redis.del(`dagbo:push:sub:${id}`);
      await redis.srem(SUBSCRIPTIONS, id);

      return res.status(200).json({
        success: true,
        message: "Notifications disabled"
      });
    }

    // 4. SEND SIGNAL NOTIFICATION
    if (req.method === "POST" && action === "send") {
      if (!authorized(req)) {
        return res.status(401).json({
          error: "Unauthorized"
        });
      }

      const {
        pair,
        signal,
        entry,
        stopLoss,
        takeProfit
      } = req.body || {};

      const allowed = [
        "STRONG BUY",
        "WEAK BUY",
        "STRONG SELL",
        "WEAK SELL",
        "NO TRADE"
      ];

      if (
        typeof pair !== "string" ||
        !/^[A-Z0-9]{3,12}$/.test(pair.toUpperCase()) ||
        typeof signal !== "string" ||
        !allowed.includes(signal.toUpperCase())
      ) {
        return res.status(400).json({
          error: "Invalid pair or signal"
        });
      }

      const payload = JSON.stringify({
        title: `DAGBO SIGNAL — ${pair}`,
        body: `${signal.toUpperCase()} signal detected for ${pair}.`,
        pair,
        signal: signal.toUpperCase(),
        entry: entry ?? null,
        stopLoss: stopLoss ?? null,
        takeProfit: takeProfit ?? null,
        url: "/signals.html",
        tag: `dagbo-${pair}`,
        timestamp: new Date().toISOString()
      });

      const ids = await redis.smembers(SUBSCRIPTIONS);

      let sent = 0;
      let failed = 0;
      let removed = 0;

      for (const id of ids) {
        const key = `dagbo:push:sub:${id}`;

        try {
          const stored = await redis.get(key);

          if (!stored) {
            await redis.srem(SUBSCRIPTIONS, id);
            continue;
          }

          const sub = typeof stored === "string"
            ? JSON.parse(stored)
            : stored;

          await webpush.sendNotification(
            sub,
            payload,
            {
              TTL: 60,
              urgency: "high",
              topic: `dagbo-${pair}`
            }
          );

          sent++;

        } catch (error) {
          failed++;

          if ([404, 410].includes(error.statusCode)) {
            await redis.del(key);
            await redis.srem(SUBSCRIPTIONS, id);
            removed++;
          } else {
            console.error("Push error:", error.message);
          }
        }
      }

      return res.status(200).json({
        success: true,
        total: ids.length,
        sent,
        failed,
        removed
      });
    }

    return res.status(404).json({
      error: "Unknown push action"
    });

  } catch (error) {
    console.error("DAGBO PUSH ERROR:", error);

    return res.status(500).json({
      error: "Push service failed"
    });
  }
};

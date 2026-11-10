const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});
const SUBSCRIPTIONS = "dagbo:push:subscriptions";

function deviceId(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}
function validSubscription(sub) {
  return !!(sub && typeof sub.endpoint === "string" && sub.endpoint.startsWith("https://") &&
    sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string");
}
function positive(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
  try {
    const body = req.body || {};
    const subscription = body.subscription;
    if (!validSubscription(subscription)) return res.status(400).json({ error: "Enable push notifications on this device first." });
    const id = deviceId(subscription.endpoint);
    const registered = await redis.sismember(SUBSCRIPTIONS, id);
    if (!registered) return res.status(403).json({ error: "This device is not registered for push notifications. Enable notifications again." });

    const action = req.query && req.query.action;
    const setKey = "dagbo:trades:device:" + id;

    if (action === "preferences") {
      const allowed = new Set(["XAUUSD","GOLD","EURUSD","GBPUSD","USDJPY","GBPJPY","AUDUSD","USDCHF","USDCAD","NZDUSD","EURJPY","EURGBP","US30","US100","NAS100","US500","BTCUSD","BTC","ETHUSD","ETH"]);
      const pairs = Array.isArray(body.pairs) ? body.pairs.map(x => String(x).toUpperCase()).filter(x => allowed.has(x)) : [];
      const unique = Array.from(new Set(pairs)).slice(0, 6);
      if (!unique.length) return res.status(400).json({ error: "Choose at least one supported market." });
      await redis.set("dagbo:scan:pairs:" + id, JSON.stringify(unique), { ex: 60 * 60 * 24 * 90 });
      return res.status(200).json({ success: true, pairs: unique, maxPairs: 6 });
    }

    if (action === "open") {
      const pair = String(body.pair || "").toUpperCase();
      const direction = String(body.direction || "").toUpperCase();
      const entry = positive(body.entry), stopLoss = positive(body.stopLoss), takeProfit = positive(body.takeProfit);
      const lotSize = positive(body.lotSize) || 0.01;
      if (!/^[A-Z0-9]{3,12}$/.test(pair) || !["BUY","SELL"].includes(direction) ||
          entry === null || stopLoss === null || takeProfit === null ||
          (direction === "BUY" && !(stopLoss < entry && takeProfit > entry)) ||
          (direction === "SELL" && !(stopLoss > entry && takeProfit < entry))) {
        return res.status(400).json({ error: "Invalid trade details or SL/TP direction." });
      }
      const ids = await redis.smembers(setKey);
      for (const tradeId of ids) {
        const raw = await redis.get("dagbo:trade:" + id + ":" + tradeId);
        if (!raw) continue;
        const old = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (old.status === "OPEN" && old.pair === pair) {
          return res.status(409).json({ error: "An open trade already exists for " + pair + ".", trade: old });
        }
      }
      const tradeId = crypto.randomUUID();
      const trade = {
        id: tradeId, pair, direction, entry, stopLoss, takeProfit, lotSize,
        status: "OPEN", result: "OPEN", pnl: 0,
        dateOpened: new Date().toISOString(), dateClosed: null
      };
      await redis.set("dagbo:trade:" + id + ":" + tradeId, JSON.stringify(trade), { ex: 60 * 60 * 24 * 90 });
      await redis.sadd(setKey, tradeId);
      await redis.sadd("dagbo:trades:devices", id);
      return res.status(201).json({ success: true, trade });
    }

    if (action === "close") {
      const tradeId = String(body.tradeId || "");
      if (!/^[a-f0-9-]{20,40}$/i.test(tradeId)) return res.status(400).json({ error: "Invalid trade ID" });
      const key = "dagbo:trade:" + id + ":" + tradeId;
      const raw = await redis.get(key);
      if (!raw) return res.status(404).json({ error: "Trade not found" });
      const trade = typeof raw === "string" ? JSON.parse(raw) : raw;
      trade.status = "CLOSED";
      trade.result = ["WIN","LOSS","BREAKEVEN"].includes(body.result) ? body.result : "CLOSED";
      trade.pnl = Number.isFinite(Number(body.pnl)) ? Number(body.pnl) : 0;
      trade.dateClosed = new Date().toISOString();
      trade.closeReason = "MANUAL";
      await redis.set(key, JSON.stringify(trade), { ex: 60 * 60 * 24 * 90 });
      return res.status(200).json({ success: true, trade });
    }

    if (action === "list") {
      const ids = await redis.smembers(setKey);
      const result = [];
      for (const tradeId of ids) {
        const raw = await redis.get("dagbo:trade:" + id + ":" + tradeId);
        if (raw) result.push(typeof raw === "string" ? JSON.parse(raw) : raw);
      }
      return res.status(200).json({ success: true, trades: result });
    }

    return res.status(404).json({ error: "Unknown trade action" });
  } catch (error) {
    console.error("DAGBO trade tracker error:", error.message);
    return res.status(500).json({ error: "Trade tracking service failed" });
  }
};

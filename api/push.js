const webpush = require("../lib/push-adapter.js");
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const SUBSCRIPTIONS = "dagbo:push:subscriptions";
const aiRateFallback = new Map();
const AI_RATE_LIMIT = 15;
const AI_RATE_WINDOW_SECONDS = 600;

// Cloudflare Workers provide secrets on req.env; process.env is only a compatibility fallback.
function envValue(req, name) {
  return (req && req.env && req.env[name]) || (typeof process !== "undefined" && process.env && process.env[name]) || "";
}

async function checkAiRateLimit(req) {
  const forwarded = req.headers["x-real-ip"] ||
    (typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",")[0].trim() : "");
  const ip = String(forwarded || "unknown").slice(0, 100);
  const id = crypto.createHash("sha256").update(ip).digest("hex");
  const key = "dagbo:ai:rate:" + id;

  if (envValue(req, "UPSTASH_REDIS_REST_URL") && envValue(req, "UPSTASH_REDIS_REST_TOKEN")) {
    try {
      const redis = getRedis(req);
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, AI_RATE_WINDOW_SECONDS);
      return { allowed: count <= AI_RATE_LIMIT, remaining: Math.max(0, AI_RATE_LIMIT - count) };
    } catch (error) {
      console.error("DAGBO AI rate-limit Redis error:", error.message);
    }
  }

  // Fallback for deployments without Redis; serverless instances may have separate counters.
  const now = Date.now();
  const current = aiRateFallback.get(id);
  if (!current || now - current.startedAt >= AI_RATE_WINDOW_SECONDS * 1000) {
    aiRateFallback.set(id, { startedAt: now, count: 1 });
    return { allowed: true, remaining: AI_RATE_LIMIT - 1 };
  }
  current.count += 1;
  return { allowed: current.count <= AI_RATE_LIMIT, remaining: Math.max(0, AI_RATE_LIMIT - current.count) };
}

function getRedis(req) {
  const url = envValue(req, "UPSTASH_REDIS_REST_URL");
  const token = envValue(req, "UPSTASH_REDIS_REST_TOKEN");
  if (!url || !token) throw new Error("Push storage is not configured");
  return new Redis({ url, token });
}

function configureVapid(req) {
  const subject = envValue(req, "VAPID_SUBJECT");
  const publicKey = envValue(req, "VAPID_PUBLIC_KEY");
  const privateKey = envValue(req, "VAPID_PRIVATE_KEY");
  if (!subject || !publicKey || !privateKey) throw new Error("VAPID keys are not configured");
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

function getId(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

function authorized(req) {
  const secret = envValue(req, "SIGNAL_PUSH_SECURITY") || envValue(req, "SIGNAL_PUSH_SECRET") || envValue(req, "DAGBO_CRON_SECRET") || envValue(req, "CRON_SECRET");
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
      if (!envValue(req, "VAPID_PUBLIC_KEY")) {
        return res.status(503).json({ error: "Push notifications are not configured on the server" });
      }
      return res.status(200).json({ publicKey: envValue(req, "VAPID_PUBLIC_KEY") });
    }

    if (req.method === "POST" && action === "test") {
      const subscription = req.body;
      if (!validSubscription(subscription)) return res.status(400).json({ error: "Invalid subscription" });
      configureVapid(req);
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
      const redis = getRedis(req);
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
      const redis = getRedis(req);
      const id = getId(endpoint);
      await redis.del("dagbo:push:sub:" + id);
      await redis.srem(SUBSCRIPTIONS, id);
      return res.status(200).json({ success: true, message: "Notifications disabled" });
    }

    if (req.method === "POST" && action === "send") {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      const { pair, signal, entry, stopLoss, takeProfit, timeframe, signalId } = req.body || {};
      const normalizedPair = typeof pair === "string" ? pair.trim().toUpperCase() : "";
      const normalizedSignal = typeof signal === "string" ? signal.trim().toUpperCase() : "";
      const allowed = ["STRONG BUY", "WEAK BUY", "STRONG SELL", "WEAK SELL"];
      const priceEntry = Number(entry), priceSL = Number(stopLoss), priceTP = Number(takeProfit);
      const isBuy = normalizedSignal.includes("BUY");
      const validPrices = [priceEntry, priceSL, priceTP].every(n => Number.isFinite(n) && n > 0) &&
        (isBuy ? priceSL < priceEntry && priceTP > priceEntry : priceSL > priceEntry && priceTP < priceEntry);
      if (!/^[A-Z0-9]{3,12}$/.test(normalizedPair) ||
          !allowed.includes(normalizedSignal) || !validPrices) {
        return res.status(400).json({ error: "Invalid signal. A valid pair, direction and correctly ordered Entry/SL/TP are required." });
      }
      const safeTimeframe = ["5m", "15m", "30m", "1h", "4h", "1d"].includes(String(timeframe || "").toLowerCase())
        ? String(timeframe).toLowerCase() : "unspecified";
      const dedupeSource = String(signalId || [normalizedPair, normalizedSignal, safeTimeframe, priceEntry, priceSL, priceTP].join("|")).slice(0, 300);
      const dedupeHash = crypto.createHash("sha256").update(dedupeSource).digest("hex");
      configureVapid(req);
      const redis = getRedis(req);
      const claimed = await redis.set("dagbo:push:signal:" + dedupeHash, "sent", { nx: true, ex: 60 * 60 * 6 });
      if (claimed !== "OK") {
        return res.status(200).json({ success: true, duplicate: true, sent: 0, message: "This signal notification was already processed." });
      }
      const ids = await redis.smembers(SUBSCRIPTIONS);
      let sent = 0, failed = 0, removed = 0;

      for (const id of ids) {
        const key = "dagbo:push:sub:" + id;
        try {
          const stored = await redis.get(key);
          if (!stored) { await redis.srem(SUBSCRIPTIONS, id); continue; }
          const sub = typeof stored === "string" ? JSON.parse(stored) : stored;
          await webpush.sendNotification(sub, JSON.stringify({
            title: "DAGBO SIGNAL — " + normalizedPair,
            body: normalizedSignal + " signal detected for " + normalizedPair + " (" + safeTimeframe + "). Entry " + priceEntry + ", SL " + priceSL + ", TP " + priceTP + ".",
            pair: normalizedPair, signal: normalizedSignal, timeframe: safeTimeframe,
            entry: priceEntry, stopLoss: priceSL, takeProfit: priceTP,
            url: "/signals.html"
          }), { TTL: 60, urgency: "high", topic: "dagbo-" + normalizedPair });
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

    // 5. AI BACKGROUND NOTIFICATION
    if (req.method === "POST" && action === "ask-ai") {
      const { question, name, subscription, marketContext, history } = req.body || {};
      const safeMarketContext = typeof marketContext === "string" ? marketContext.slice(0, 2500) : "";
      const safeName = typeof name === "string" ? name.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 32) : "Oga";
      const safeHistory = Array.isArray(history) ? history.slice(-10).filter(function(item) {
        return item && (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string" && item.content.trim().length > 0;
      }).map(function(item) {
        return { role: item.role, content: item.content.slice(0, 1200) };
      }) : [];
      const groqKey = envValue(req, "GROQ_API_KEY");
      // Fetch a real Twelve Data quote for explicit pair questions or the pair
      // selected in the user's saved chart snapshots. Never ask the model to guess.
      const pairSymbols = {
        XAUUSD:"XAU/USD", GOLD:"XAU/USD", EURUSD:"EUR/USD", GBPUSD:"GBP/USD",
        USDJPY:"USD/JPY", GBPJPY:"GBP/JPY", AUDUSD:"AUD/USD", USDCHF:"USD/CHF",
        USDCAD:"USD/CAD", NZDUSD:"NZD/USD", EURJPY:"EUR/JPY", EURGBP:"EUR/GBP",
        BTCUSD:"BTC/USD", ETHUSD:"ETH/USD", US30:"DJI", US100:"NDX", NAS100:"NDX", US500:"SPX"
      };
      const asksPrice = /\b(price|quote|trading at|how much is|current value)\b/i.test(question);
      let quotePair = Object.keys(pairSymbols).find(pair => new RegExp("\\b" + pair + "\\b", "i").test(question));
      if (!quotePair && asksPrice && /\b(this pair|current pair|selected pair)\b/i.test(question) && safeMarketContext) {
        try {
          const snapshot = JSON.parse(safeMarketContext);
          const walk = (value) => {
            if (!value || typeof value !== "object") return null;
            for (const key of Object.keys(value)) {
              const normalized = key.toUpperCase().replace("/", "").replace("_", "");
              if (pairSymbols[normalized]) return normalized;
              const found = walk(value[key]);
              if (found) return found;
            }
            return null;
          };
          quotePair = walk(snapshot);
        } catch (_) {}
      }
      let liveQuoteContext = "";
      if (asksPrice) {
        const quoteKey = envValue(req, "TWELVE_DATA_API_KEY");
        if (quotePair && quoteKey) {
          try {
            const quoteUrl = "https://api.twelvedata.com/quote?symbol=" +
              encodeURIComponent(pairSymbols[quotePair]) + "&apikey=" + encodeURIComponent(quoteKey);
            const quoteResponse = await fetch(quoteUrl);
            const quote = await quoteResponse.json();
            const price = Number(quote.close || quote.price);
            if (quoteResponse.ok && Number.isFinite(price) && price > 0) {
              liveQuoteContext = "Verified Twelve Data quote for " + quotePair +
                ": latest price " + price + ", timestamp " + (quote.datetime || quote.timestamp || "not supplied") + ".";
            } else {
              liveQuoteContext = "Live quote unavailable for " + quotePair + ". Do not guess the price.";
            }
          } catch (_) {
            liveQuoteContext = "Live quote service unavailable. Do not guess the price.";
          }
        } else {
          liveQuoteContext = quotePair
            ? "Live quote API key is not configured. Do not guess the price."
            : "No pair could be identified from the question or saved chart context. Ask which pair the user means.";
        }
      }
      let economicCalendarContext = "";
      const asksNews = /\b(news|headline|economic calendar|economic event|cpi|ppi|pce|nfp|nonfarm|payroll|inflation|interest rate|central bank|fomc|federal reserve|ecb|boe|boj|gdp|unemployment|actual|forecast|market spike|spike)\b/i.test(String(question || ""));
      if (asksNews) {
        try {
          const calendarUrl = "https://showmytrades.com/api/public/calendar/v1?currency=USD%2CEUR%2CGBP%2CJPY%2CAUD%2CNZD%2CCAD%2CCHF%2CCNY&impact=all&days=3";
          const calendarResponse = await fetch(calendarUrl, { headers: { "Accept": "application/json", "User-Agent": "DAGBO-SIGNAL-AI/1.0" } });
          const calendarData = calendarResponse.ok ? await calendarResponse.json() : null;
          if (calendarData && Array.isArray(calendarData.events)) {
            const events = calendarData.events.slice(0, 12).map(event => ({
              time: event.time || (Number(event.ts) ? new Date(Number(event.ts) * 1000).toISOString() : ""),
              currency: event.currency, impact: event.impact, title: event.title,
              actual: event.actual || "", forecast: event.forecast || "", previous: event.previous || "",
              status: event.status || "scheduled", confidence: event.confidence || ""
            }));
            economicCalendarContext = "ShowMyTrades economic calendar (fetched " + (calendarData.generated_at || new Date().toISOString()) +
              "; event times are UTC; schedule/data can change): " + JSON.stringify(events) +
              ". Use these as scheduled-event context only. Actual may be blank before release. Do not infer a price direction from event importance alone.";
          } else {
            economicCalendarContext = "ShowMyTrades economic calendar is temporarily unavailable; do not invent upcoming event details.";
          }
          try {
            const rssResponse = await fetch("https://www.fxstreet.com/rss/news", {
              headers: { "Accept": "application/rss+xml, application/xml, text/xml", "User-Agent": "DAGBO-SIGNAL-AI/1.0" }
            });
            if (rssResponse.ok) {
              const xml = await rssResponse.text();
              const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
              const headlines = blocks.slice(0, 6).map(block => {
                const read = tag => {
                  const match = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"));
                  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() : "";
                };
                return { title: read("title"), published: read("pubDate"), summary: read("description").slice(0, 240) };
              }).filter(item => item.title);
              if (headlines.length) economicCalendarContext += " Recent FXStreet headlines (headline feed, not independently verified): " + JSON.stringify(headlines) + ". Treat these as reported headlines, not confirmed causal explanations.";
            }
          } catch (error) {
            economicCalendarContext += " Live FXStreet headline feed unavailable.";
          }
        } catch (error) {
          economicCalendarContext = "ShowMyTrades economic calendar could not be reached; do not invent upcoming event details.";
        }
      }

      if (typeof question !== "string" || !question.trim() || question.length > 2000 || !groqKey) {
        return res.status(!groqKey ? 503 : 400).json({
          error: !groqKey ? "AI service is not configured on the server" : "A valid question is required"
        });
      }

      const rate = await checkAiRateLimit(req);
      if (!rate.allowed) {
        res.setHeader("Retry-After", String(AI_RATE_WINDOW_SECONDS));
        return res.status(429).json({ error: "Dagbo AI is receiving too many requests. Please wait a few minutes and try again." });
      }

      // Keep the Groq API key on the server; never accept it from the browser.
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages: [
            {
              role: "system",
              content: "You are DAGBO AI Market Commander for " + (safeName || "Oga") + ". Answer exactly what the user asks and perform the requested task; do not add unrelated advice. Be concise: greetings get one short greeting, simple questions get one direct answer, and use bullets only when useful. Speak in clear Nigerian-friendly English or Pidgin when natural. For live-price questions, use only a verified live quote supplied in the context below; if unavailable, say so and ask which pair is meant. Never invent prices, news, indicators or market conditions. For news and economic-event questions, explain the topic freely using the live economic-calendar context when supplied; distinguish scheduled events, published actual/forecast figures and unverified breaking headlines. If live headline data is not supplied, say you cannot verify breaking news right now. Treat device snapshots as potentially stale. A closed market must never prevent you from answering questions, explaining a signal, reviewing a setup, teaching, or discussing news. If the market is closed, explicitly label any saved candle/price context as last available data and analysis only; never call it a live executable trade. When the user requests a trade signal or setup, provide pair, BUY/SELL/WAIT, timeframe, entry, stop loss and take profit, plus one brief reason. Entry, SL and TP must be derived from fresh market data and a clearly defined setup, with correct price ordering for the direction. If fresh data or a valid setup is missing, return WAIT and explicitly say entry/SL/TP are not available; never fabricate levels. Never guarantee profits. Keep ordinary answers to 1-3 short sentences."
            },
            ...safeHistory,
            { role: "user", content: question.trim() + (liveQuoteContext ? "\n\nLIVE QUOTE CONTEXT: " + liveQuoteContext : "") + (economicCalendarContext ? "\n\nECONOMIC CALENDAR CONTEXT: " + economicCalendarContext : "") + (safeMarketContext ? "\n\nLatest saved DAGBO signal context (device snapshot; may be stale): " + safeMarketContext : "") }
          ],
          temperature: 0.3,
          max_tokens: 220
        })
      });

      const groqData = await groqRes.json();
      if (!groqRes.ok) {
        console.error("DAGBO GROQ ERROR:", groqData.error && groqData.error.message);
        return res.status(502).json({ error: "The AI service could not answer right now" });
      }

      const rawAnswer = groqData.choices && groqData.choices[0] &&
        groqData.choices[0].message && groqData.choices[0].message.content;
      if (typeof rawAnswer !== "string" || !rawAnswer.trim()) {
        return res.status(502).json({ error: "The AI returned an empty answer" });
      }

      // Notify only the device that asked the question, never every app subscriber.
      if (validSubscription(subscription)) {
        try {
          // Push is optional: a missing VAPID setup must not block the AI answer.
          configureVapid(req);
          await webpush.sendNotification(subscription, JSON.stringify({
            title: "🤖 Dagbo AI Answer",
            body: (rawAnswer.trim().replace(/\s+/g, " ").slice(0, 190) + (rawAnswer.trim().length > 190 ? "…" : "")),
            url: "/ai.html",
            tag: "dagbo-ai-" + Date.now()
          }), { TTL: 60, urgency: "normal" });
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) {
            try {
              const redis = getRedis(req);
              const id = getId(subscription.endpoint);
              await redis.del("dagbo:push:sub:" + id);
              await redis.srem(SUBSCRIPTIONS, id);
            } catch (cleanupError) {
              console.error("DAGBO AI subscription cleanup error:", cleanupError.message);
            }
          } else {
            console.error("DAGBO AI push delivery error:", error.message);
          }
        }
      }

      // Return plain text; let the page render it safely rather than injecting HTML.
      return res.status(200).json({ success: true, answer: rawAnswer.trim() });
    }

    return res.status(404).json({ error: "Unknown push action" });
  } catch (error) {
    console.error("DAGBO PUSH ERROR:", error.message);
    return res.status(500).json({ error: error.message || "Push service failed" });
  }
};

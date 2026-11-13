const { Redis } = require("@upstash/redis");
const webpush = require("web-push");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const PAIRS = ["GBPUSD", "GBPJPY", "EURUSD", "XAUUSD"];
const SYMBOLS = {
  GBPUSD: "GBP/USD",
  GBPJPY: "GBP/JPY",
  EURUSD: "EUR/USD",
  XAUUSD: "XAU/USD"
};
const CURRENCY_PAIRS = {
  USD: ["GBPUSD", "EURUSD", "XAUUSD"],
  GBP: ["GBPUSD", "GBPJPY"],
  EUR: ["EURUSD"],
  JPY: ["GBPJPY"]
};

function validAuth(req) {
  const secret = process.env.DAGBO_CRON_SECRET || process.env.CRON_SECRET ||
    process.env.SIGNAL_PUSH_SECURITY || process.env.SIGNAL_PUSH_SECRET;
  const auth = req.headers.authorization || "";
  if (!secret) return false;
  const a = Buffer.from(auth);
  const b = Buffer.from("Bearer " + secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function cleanText(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
function rssItems(xml) {
  const items = [];
  const matches = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of matches.slice(0, 20)) {
    const field = name => {
      const match = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
      return match ? cleanText(match[1]) : "";
    };
    const title = field("title");
    const link = field("link");
    const published = field("pubDate");
    const description = field("description");
    if (title && link) items.push({ title, link, published, description });
  }
  return items;
}
function relevantHeadline(item) {
  const text = (item.title + " " + item.description).toLowerCase();
  return /(fed|federal reserve|fomc|ecb|european central bank|boe|bank of england|boj|bank of japan|central bank|interest rate|rate decision|inflation|cpi|pce|ppi|payroll|nonfarm|nfp|unemployment|jobs report|gdp|intervention|currency|sterling|pound|euro|dollar|yen|gold|bullion|treasury yield|bond yield|tariff|sanction|geopolit|war|oil shock|emergency meeting|resign|ceasefire)/i.test(text);
}
async function broadcast(title, body, tag, url) {
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) throw new Error("VAPID push keys are not configured");
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const ids = await redis.smembers("dagbo:push:subscriptions");
  let sent = 0, failed = 0;
  for (const id of ids) {
    const key = "dagbo:push:sub:" + id;
    const raw = await redis.get(key);
    if (!raw) { await redis.srem("dagbo:push:subscriptions", id); continue; }
    try {
      const subscription = typeof raw === "string" ? JSON.parse(raw) : raw;
      await webpush.sendNotification(subscription, JSON.stringify({
        title, body, tag, url: url || "/news.html"
      }), { TTL: 1800, urgency: "high" });
      sent++;
    } catch (error) {
      failed++;
      if ([404, 410].includes(error.statusCode)) {
        await redis.del(key);
        await redis.srem("dagbo:push:subscriptions", id);
      } else console.error("DAGBO news push failed:", error.message);
    }
  }
  return { sent, failed, devices: ids.length };
}
async function fetchCandles(pair, interval, apiKey, outputsize) {
  const symbol = SYMBOLS[pair];
  if (!symbol) throw new Error("Pair is not enabled for news-spike analysis");
  const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(symbol) +
    "&interval=" + encodeURIComponent(interval) + "&outputsize=" + (outputsize || 30) +
    "&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(data.message || "Twelve Data candle request failed");
  }
  return data.values.slice().reverse();
}
function candleTime(candle) {
  const raw = String(candle.datetime || "");
  const parsed = Date.parse(raw.replace(" ", "T") + (raw.includes("Z") || /[+-]\d\d:\d\d$/.test(raw) ? "" : "Z"));
  return Number.isFinite(parsed) ? parsed : NaN;
}
function preNewsSummary(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const chosen = candles.slice(-2);
  const open = num(chosen[0].open);
  const close = num(chosen[1].close);
  if (open === null || close === null || open <= 0) return null;
  const pct = (close - open) / open * 100;
  return { direction: pct > 0 ? "BUY" : pct < 0 ? "SELL" : "WAIT", pct };
}
function eventPairs(currency) {
  return CURRENCY_PAIRS[currency] || (currency === "GLOBAL" ? PAIRS : []);
}
function eventIdentity(event) {
  return crypto.createHash("sha256")
    .update([event.name, event.currency, event.date.toISOString()].join("|"))
    .digest("hex").slice(0, 24);
}
async function sendBreakingNews() {
  let checked = 0, sent = 0;
  const feeds = ["https://www.forexlive.com/feed/"];
  for (const feed of feeds) {
    try {
      const response = await fetch(feed, {
        headers: { "User-Agent": "DAGBO-SIGNAL-News-Monitor/1.0", "Accept": "application/rss+xml, application/xml, text/xml" }
      });
      if (!response.ok) throw new Error("RSS HTTP " + response.status);
      const xml = await response.text();
      const items = rssItems(xml);
      checked += items.length;
      for (const item of items.slice(0, 12).reverse()) {
        if (!relevantHeadline(item)) continue;
        const publishedAt = Date.parse(item.published);
        if (Number.isFinite(publishedAt) && Date.now() - publishedAt > 3 * 60 * 60 * 1000) continue;
        const id = crypto.createHash("sha256").update(item.link || item.title).digest("hex").slice(0, 24);
        const key = "dagbo:breaking:sent:" + id;
        if (await redis.get(key)) continue;
        const description = item.description ? " — " + item.description.slice(0, 230) : "";
        await broadcast("🚨 BREAKING FX NEWS", item.title + description + " Source: investingLive / ForexLive. Verify the report before trading.", "breaking-" + id, "/news.html");
        await redis.set(key, "1", { ex: 60 * 60 * 24 * 7 });
        sent++;
      }
      break;
    } catch (error) {
      console.error("DAGBO breaking-news feed failed:", error.message);
    }
  }
  return { checked, sent };
}
async function sendEconomicNews(apiKey) {
  const now = Date.now();
  const result = { highImpactEvents: 0, oneHourAlerts: 0, preNewsBiasAlerts: 0, postNewsResults: 0, errors: [] };
  const response = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    headers: { "User-Agent": "DAGBO-SIGNAL-Economic-Calendar/2.0" }
  });
  if (!response.ok) throw new Error("Economic calendar HTTP " + response.status);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Economic calendar returned invalid data");

  const events = rows.map(row => ({
    name: String(row.title || "Economic event").slice(0, 120),
    currency: String(row.country || "GLOBAL").toUpperCase(),
    impact: String(row.impact || "").toLowerCase(),
    date: new Date(row.date),
    actual: row.actual === undefined || row.actual === null ? "" : String(row.actual),
    forecast: row.forecast === undefined || row.forecast === null ? "" : String(row.forecast),
    previous: row.previous === undefined || row.previous === null ? "" : String(row.previous)
  })).filter(event => event.impact === "high" && Number.isFinite(event.date.getTime()) &&
    ["USD", "GBP", "EUR", "JPY", "GLOBAL"].includes(event.currency) &&
    event.date.getTime() >= now - 35 * 60 * 1000 &&
    event.date.getTime() <= now + 70 * 60 * 1000);

  result.highImpactEvents = events.length;
  for (const event of events) {
    const id = eventIdentity(event);
    const mins = (event.date.getTime() - now) / 60000;
    const pairs = eventPairs(event.currency);
    const pairText = pairs.join(", ") || "GBPUSD, GBPJPY, EURUSD, XAUUSD";

    // One-hour warning: 50-70 minute window, with Redis de-duplication.
    if (mins <= 70 && mins > 50) {
      const key = "dagbo:news:one-hour:" + id;
      if (!(await redis.get(key))) {
        await broadcast("⏰ HIGH-IMPACT NEWS IN ABOUT 1 HOUR",
          event.currency + " · " + event.name + " is due in about " + Math.round(mins) +
          " minutes. Watch: " + pairText + ". DAGBO will check the pre-news bias near 15 minutes before release. Avoid entering blindly; spreads and slippage can expand.",
          "news-1h-" + id, "/news.html");
        await redis.set(key, "1", { ex: 60 * 60 * 48 });
        result.oneHourAlerts++;
      }
    }

    // 15-minute directional context: only the four approved instruments.
    if (mins <= 20 && mins > 10 && apiKey && pairs.length) {
      const key = "dagbo:news:pre-bias:" + id;
      if (!(await redis.get(key))) {
        const snapshots = await Promise.all(pairs.map(async pair => {
          try {
            const candles = await fetchCandles(pair, "15min", apiKey, 12);
            const completed = candles.filter(c => candleTime(c) + 15 * 60 * 1000 <= event.date.getTime() - 10 * 60 * 1000);
            const summary = preNewsSummary(completed);
            return summary ? { pair, ...summary } : { pair, direction: "WAIT", unavailable: true };
          } catch (error) {
            result.errors.push(pair + " pre-news: " + error.message);
            return { pair, direction: "WAIT", unavailable: true };
          }
        }));
        const lines = snapshots.map(s => s.pair + ": " + s.direction +
          (Number.isFinite(s.pct) ? " (" + s.pct.toFixed(3) + "%)" : " (insufficient data)"));
        const active = snapshots.filter(s => s.direction !== "WAIT");
        const buys = active.filter(s => s.direction === "BUY").length;
        const sells = active.filter(s => s.direction === "SELL").length;
        const consensus = active.length < 2 || buys === sells ? "MIXED / WAIT" : buys > sells ? "BUY-LEANING" : "SELL-LEANING";
        await broadcast("📊 15-MIN PRE-NEWS SPIKE BIAS — " + event.currency,
          event.name + " releases in about " + Math.round(mins) + " minutes. " + consensus +
          ". Approved instruments only: " + lines.join(" · ") +
          ". This is a pre-release price/flow bias, not a prediction of the actual result or a guaranteed direction. Confirm spread, liquidity and risk.",
          "news-pre-bias-" + id, "/news.html");
        await redis.set(key, "1", { ex: 60 * 60 * 48 });
        result.preNewsBiasAlerts++;
      }
    }

    // Post-release: wait for at least 3 minutes, then report actual vs forecast
    // and the first completed 1-minute-candle reaction for relevant approved pairs.
    if (mins <= -3 && mins >= -35) {
      const key = "dagbo:news:post-result:" + id;
      if (!(await redis.get(key))) {
        const reactionLines = [];
        if (apiKey && pairs.length) {
          for (const pair of pairs) {
            try {
              const candles = await fetchCandles(pair, "1min", apiKey, 20);
              const after = candles.filter(c => candleTime(c) >= event.date.getTime() && candleTime(c) + 60000 <= now);
              if (after.length >= 1) {
                const firstOpen = num(after[0].open);
                const firstClose = num(after[0].close);
                const lastClose = num(after[after.length - 1].close);
                if (firstOpen !== null && firstOpen > 0 && firstClose !== null && lastClose !== null) {
                  const firstPct = (firstClose - firstOpen) / firstOpen * 100;
                  const totalPct = (lastClose - firstOpen) / firstOpen * 100;
                  const firstMove = firstPct > 0 ? "UP" : firstPct < 0 ? "DOWN" : "FLAT";
                  const totalMove = totalPct > 0 ? "UP" : totalPct < 0 ? "DOWN" : "FLAT";
                  reactionLines.push(pair + " first 1m " + firstMove + " " + firstPct.toFixed(3) +
                    "%; cumulative " + totalMove + " " + totalPct.toFixed(3) + "%");
                } else reactionLines.push(pair + " reaction unavailable");
              } else reactionLines.push(pair + " waiting for completed post-release candle");
            } catch (error) {
              result.errors.push(pair + " post-news: " + error.message);
              reactionLines.push(pair + " reaction unavailable");
            }
          }
        }
        const actual = event.actual || "Not yet reported by calendar";
        const forecast = event.forecast || "not supplied";
        const previous = event.previous || "not supplied";
        await broadcast("⚡ POST-NEWS RESULT — " + event.currency,
          event.name + " · Actual: " + actual + " · Forecast: " + forecast + " · Previous: " + previous +
          ". Price reaction since release: " + (reactionLines.join(" · ") || "market data unavailable") +
          ". Reaction is an observed move, not a prediction. Check the chart and broker execution.",
          "news-post-result-" + id, "/news.html");
        await redis.set(key, "1", { ex: 60 * 60 * 48 });
        result.postNewsResults++;
      }
    }
  }
  return result;
}
async function runNewsMonitor() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Upstash Redis is not configured");
  }
  const lockKey = "dagbo:news:monitor:lock";
  const lock = await redis.set(lockKey, String(Date.now()), { nx: true, ex: 4 * 60 });
  if (lock !== "OK") return { skipped: true, reason: "News monitor already running" };
  try {
    const apiKey = process.env.NEWS_SPIKE_TWELVE_DATA_API_KEY ||
      process.env.SPIKE_TWELVE_DATA_API_KEY || "";
    let economic = { highImpactEvents: 0, oneHourAlerts: 0, preNewsBiasAlerts: 0, postNewsResults: 0, errors: [] };
    try { economic = await sendEconomicNews(apiKey); }
    catch (error) { economic.errors.push("Calendar: " + error.message); console.error("DAGBO calendar monitor:", error.message); }
    let breaking = { checked: 0, sent: 0 };
    try { breaking = await sendBreakingNews(); }
    catch (error) { console.error("DAGBO breaking news:", error.message); }
    const summary = { success: true, checkedAt: new Date().toISOString(), economic, breaking,
      spikePairs: PAIRS, spikeApiKeyConfigured: !!apiKey };
    await redis.set("dagbo:news:monitor:last", JSON.stringify(summary), { ex: 60 * 60 * 24 * 7 });
    return summary;
  } finally {
    await redis.del(lockKey);
  }
}
module.exports = { runNewsMonitor, validAuth };

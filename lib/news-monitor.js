const { Redis } = require("@upstash/redis");
const webpush = require("web-push");
const crypto = require("crypto");
const { fetchFcsCalendarEvents } = require("./fcs-calendar");

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
    process.env.SIGNAL_PUSH_SECURITY || process.env.Signal_push_security || process.env.SIGNAL_PUSH_SECRET;
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
const { claimTwelveDataSlot } = require("./twelve-data-quota");
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
  if (!await claimTwelveDataSlot()) throw new Error("Shared Twelve Data minute quota is busy; retry on the next news-monitor cycle.");
  const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(symbol) +
    "&interval=" + encodeURIComponent(interval) + "&outputsize=" + (outputsize || 30) +
    "&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
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
function preNewsSummary(candles, event, now) {
  if (!Array.isArray(candles) || candles.length < 10) return null;
  const bars = candles.slice(-10);
  const last = bars[bars.length - 1];
  const open = num(bars[0].open);
  const close = num(last.close);
  if (open === null || close === null || open <= 0) return null;

  const ranges = bars.map(c => {
    const high = num(c.high), low = num(c.low);
    return high !== null && low !== null && high >= low ? high - low : null;
  });
  if (ranges.some(x => x === null)) return null;
  const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const recentRange = mean(ranges.slice(-3));
  const baselineRange = mean(ranges.slice(0, 7));
  const compression = baselineRange > 0 && recentRange <= baselineRange * 0.85;

  const prior = bars.slice(0, -1);
  const priorHigh = Math.max(...prior.map(c => Number(c.high)));
  const priorLow = Math.min(...prior.map(c => Number(c.low)));
  const lastHigh = num(last.high), lastLow = num(last.low);
  const lastOpen = num(last.open);
  const liquiditySweepDirection = lastHigh > priorHigh && close < priorHigh ? "SELL" :
    lastLow < priorLow && close > priorLow ? "BUY" : "WAIT";

  const volumes = bars.map(c => num(c.volume ?? c.v));
  const volumeAvailable = volumes.every(v => v !== null && v >= 0) && volumes.slice(0, -1).some(v => v > 0);
  const averageVolume = volumeAvailable ? mean(volumes.slice(0, -1)) : 0;
  const volumeExpansion = volumeAvailable && averageVolume > 0 && volumes[volumes.length - 1] >= averageVolume * 1.25;
  const volumeDirection = volumeExpansion && lastOpen !== null
    ? (close > lastOpen ? "BUY" : close < lastOpen ? "SELL" : "WAIT") : "WAIT";

  const pct = (close - open) / open * 100;
  const momentumDirection = pct > 0.01 ? "BUY" : pct < -0.01 ? "SELL" : "WAIT";
  const closes = bars.map(c => num(c.close));
  const ema = (values, period) => {
    const k = 2 / (period + 1);
    return values.reduce((value, price, index) => index === 0 ? price : price * k + value * (1 - k), values[0]);
  };
  const trendFast = ema(closes, 5), trendSlow = ema(closes, 9);
  const trendDirection = trendFast > trendSlow && close > trendFast ? "BUY" :
    trendFast < trendSlow && close < trendFast ? "SELL" : "WAIT";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now || new Date());
  const clock = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const weekday = !["Sat", "Sun"].includes(clock.weekday);
  const localMinute = Number(clock.hour) * 60 + Number(clock.minute);
  const activeSession = weekday && localMinute >= 480 && localMinute < 1380;

  return {
    direction: "WAIT", momentumDirection, trendDirection, liquiditySweepDirection,
    volumeDirection, volumeAvailable, volumeExpansion, compression,
    eventConfirmed: !!(event && event.impact === "high" && event.date instanceof Date && Number.isFinite(event.date.getTime())),
    activeSession, pct, recentRange, baselineRange
  };
}
function eventPairs(currency) {
  return CURRENCY_PAIRS[currency] || (currency === "GLOBAL" ? PAIRS : []);
}
function eventIdentity(event) {
  return crypto.createHash("sha256")
    .update([event.name, event.currency, event.date.toISOString()].join("|"))
    .digest("hex").slice(0, 24);
}
async function sendFmpBreakingNews() {
  const apiKey = process.env.FMP_API_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY;
  if (!apiKey) return { checked: 0, sent: 0, source: "FMP not configured", used: false };
  const endpoints = [
    "forex-latest",
    "crypto-latest",
    "general-latest"
  ];
  let checked = 0, sent = 0, successfulFeeds = 0;
  for (const endpoint of endpoints) {
    try {
      const url = "https://financialmodelingprep.com/stable/news/" + endpoint +
        "?page=0&limit=20&apikey=" + encodeURIComponent(apiKey);
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6500) });
      let rows = [];
      try { rows = await response.json(); } catch (_) {}
      if (!response.ok || !Array.isArray(rows)) {
        const detail = rows && (rows["Error Message"] || rows.message);
        throw new Error(String(detail || ("FMP " + endpoint + " HTTP " + response.status)));
      }
      successfulFeeds++;
      checked += rows.length;
      for (const row of rows.slice().reverse()) {
        const item = {
          title: cleanText(row.title),
          description: cleanText(row.text || row.snippet || ""),
          link: String(row.url || ""),
          published: String(row.publishedDate || "")
        };
        if (!item.title || !item.link || !relevantHeadline(item)) continue;
        const publishedAt = Date.parse(item.published.replace(" ", "T") + "Z");
        if (Number.isFinite(publishedAt) && (Date.now() - publishedAt > 3 * 60 * 60 * 1000 || publishedAt > Date.now() + 5 * 60 * 1000)) continue;
        const id = crypto.createHash("sha256").update(item.link || item.title).digest("hex").slice(0, 24);
        const key = "dagbo:breaking:sent:" + id;
        if (await redis.get(key)) continue;
        const description = item.description ? " — " + item.description.slice(0, 230) : "";
        await broadcast("🚨 BREAKING MARKET NEWS", item.title + description +
          " Source: FMP (" + endpoint + "). Verify the report before trading.",
          "breaking-" + id, "/news.html");
        await redis.set(key, "1", { ex: 60 * 60 * 24 * 7 });
        sent++;
      }
      if (sent >= 8) break;
    } catch (error) {
      console.error("DAGBO FMP backup news failed (" + endpoint + "):", error.message);
    }
  }
  return { checked, sent, source: "FMP Backup", used: successfulFeeds > 0, successfulFeeds };
}
async function sendBreakingNews() {
  let checked = 0, sent = 0, primaryOk = false;
  try {
    const response = await fetch("https://www.forexlive.com/feed/", {
      headers: { "User-Agent": "DAGBO-SIGNAL-News-Monitor/1.0", "Accept": "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(6500)
    });
    if (!response.ok) throw new Error("RSS HTTP " + response.status);
    const items = rssItems(await response.text());
    primaryOk = true;
    checked += items.length;
    for (const item of items.slice(0, 12).reverse()) {
      if (!relevantHeadline(item)) continue;
      const publishedAt = Date.parse(item.published);
      if (Number.isFinite(publishedAt) && Date.now() - publishedAt > 3 * 60 * 60 * 1000) continue;
      const id = crypto.createHash("sha256").update(item.link || item.title).digest("hex").slice(0, 24);
      const key = "dagbo:breaking:sent:" + id;
      if (await redis.get(key)) continue;
      const description = item.description ? " — " + item.description.slice(0, 230) : "";
      await broadcast("🚨 BREAKING FX NEWS", item.title + description +
        " Source: ForexLive. Verify the report before trading.", "breaking-" + id, "/news.html");
      await redis.set(key, "1", { ex: 60 * 60 * 24 * 7 });
      sent++;
    }
  } catch (error) {
    console.error("DAGBO primary breaking-news feed failed:", error.message);
  }
  // FMP is a true fallback: use it when the primary RSS is unavailable or has
  // no new relevant headlines. Redis IDs prevent duplicate alerts across feeds.
  let backup = { checked: 0, sent: 0, source: "Not needed", used: false };
  if (!primaryOk || sent === 0) backup = await sendFmpBreakingNews();
  return { checked: checked + backup.checked, sent: sent + backup.sent,
    primary: primaryOk ? "ForexLive" : "unavailable", backup };
}
async function sendEconomicNews(apiKey) {
  const now = Date.now();
  const result = { highImpactEvents: 0, oneHourAlerts: 0, preNewsBiasAlerts: 0, postNewsResults: 0, errors: [] };
  let rows, calendarSource = "FCS API";
  const calendarCacheKey = "dagbo:news:calendar:last";
  try {
    rows = await fetchFcsCalendarEvents({ now: new Date(now) });
    calendarSource = rows.length ? String(rows[0].source || calendarSource) : calendarSource;
    await redis.set(calendarCacheKey, JSON.stringify({ fetchedAt: Date.now(), rows }), { ex: 60 * 60 });
  } catch (calendarError) {
    const rawCache = await redis.get(calendarCacheKey);
    const cached = rawCache ? (typeof rawCache === "string" ? JSON.parse(rawCache) : rawCache) : null;
    const ageMs = cached && Number(cached.fetchedAt) ? Date.now() - Number(cached.fetchedAt) : Infinity;
    if (!cached || !Array.isArray(cached.rows) || ageMs > 10 * 60 * 1000) throw calendarError;
    rows = cached.rows;
    calendarSource = "recent cache (" + Math.round(ageMs / 60000) + "m old)";
    result.errors.push("Calendar refresh failed; using recent cached schedule: " + calendarError.message);
  }

  const events = rows.map(row => ({
    name: String(row.title || "Economic event").slice(0, 120),
    currency: String(row.currency || row.country || "GLOBAL").toUpperCase(),
    impact: String(row.impact || "").toLowerCase(),
    date: new Date(row.date),
    actual: row.actual === undefined || row.actual === null ? "" : String(row.actual),
    forecast: row.forecast === undefined || row.forecast === null ? "" : String(row.forecast),
    previous: row.previous === undefined || row.previous === null ? "" : String(row.previous)
  })).filter(event => event.impact === "high" && Number.isFinite(event.date.getTime()) &&
    ["USD", "GBP", "EUR", "JPY", "GLOBAL"].includes(event.currency) &&
    event.date.getTime() >= now - 35 * 60 * 1000 &&
    event.date.getTime() <= now + 70 * 60 * 1000);

  result.calendarSource = calendarSource;
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

    // 15-minute pre-news spike context: likelihood and direction are scored separately.
    if (mins <= 20 && mins > 10 && apiKey && pairs.length) {
      const key = "dagbo:news:pre-bias:" + id;
      if (!(await redis.get(key))) {
        const snapshots = await Promise.all(pairs.map(async pair => {
          try {
            const candles = await fetchCandles(pair, "15min", apiKey, 16);
            const completed = candles.filter(c => candleTime(c) + 15 * 60 * 1000 <= event.date.getTime() - 10 * 60 * 1000);
            const summary = preNewsSummary(completed, event, new Date(now));
            return summary ? { pair, ...summary } : { pair, direction: "WAIT", unavailable: true };
          } catch (error) {
            result.errors.push(pair + " pre-news: " + error.message);
            return { pair, direction: "WAIT", unavailable: true };
          }
        }));
        const available = snapshots.filter(s => !s.unavailable);
        if (!available.length) {
          result.errors.push(event.name + " pre-news analysis withheld: no approved market returned ten valid closed candles.");
          continue;
        }

        // Cross-market confirmation is only counted when at least one other
        // approved instrument supplies a directional momentum reading.
        for (const snapshot of available) {
          const peers = available.filter(s => s.pair !== snapshot.pair && s.momentumDirection !== "WAIT");
          const peerBuys = peers.filter(s => s.momentumDirection === "BUY").length;
          const peerSells = peers.filter(s => s.momentumDirection === "SELL").length;
          snapshot.crossMarketDirection = peerBuys > peerSells ? "BUY" :
            peerSells > peerBuys ? "SELL" : "WAIT";

          const votes = [
            snapshot.momentumDirection, snapshot.trendDirection,
            snapshot.liquiditySweepDirection,
            snapshot.volumeExpansion ? snapshot.volumeDirection : "WAIT",
            snapshot.crossMarketDirection
          ].filter(direction => direction === "BUY" || direction === "SELL");
          const buys = votes.filter(direction => direction === "BUY").length;
          const sells = votes.filter(direction => direction === "SELL").length;
          const majority = Math.max(buys, sells);
          snapshot.direction = majority >= 3 ? (buys > sells ? "BUY" : "SELL") :
            majority >= 2 ? (buys > sells ? "BUY-LEANING" : "SELL-LEANING") : "MIXED / WAIT";
          snapshot.directionalConfirmations = majority;

          const factors = [
            snapshot.eventConfirmed,
            snapshot.compression,
            snapshot.liquiditySweepDirection !== "WAIT",
            snapshot.volumeExpansion,
            snapshot.crossMarketDirection !== "WAIT",
            snapshot.activeSession,
            snapshot.momentumDirection !== "WAIT"
          ];
          snapshot.spikeConfirmations = factors.filter(Boolean).length;
          snapshot.spikeAvailableChecks = 7 - (snapshot.volumeAvailable ? 0 : 1) -
            (snapshot.crossMarketDirection !== "WAIT" ? 0 : 1);
          const confirmationRatio = snapshot.spikeAvailableChecks
            ? snapshot.spikeConfirmations / snapshot.spikeAvailableChecks : 0;
          snapshot.spikeLikelihood = snapshot.spikeConfirmations >= 4 && confirmationRatio >= 0.7 ? "HIGH" :
            snapshot.spikeConfirmations >= 3 && confirmationRatio >= 0.5 ? "ELEVATED" : "LOW / INSUFFICIENT";
        }

        const lines = snapshots.map(s => {
          if (s.unavailable) return s.pair + ": DATA UNAVAILABLE";
          const factors = [
            "event " + (s.eventConfirmed ? "YES" : "NO"),
            "compression " + (s.compression ? "YES" : "NO"),
            "liquidity " + (s.liquiditySweepDirection !== "WAIT" ? s.liquiditySweepDirection : "NO"),
            "volume " + (s.volumeAvailable ? (s.volumeExpansion ? "EXPANSION" : "NORMAL") : "UNAVAILABLE"),
            "cross-market " + (s.crossMarketDirection || "UNAVAILABLE"),
            "session " + (s.activeSession ? "ACTIVE" : "QUIET"),
            "momentum " + s.momentumDirection
          ].join(", ");
          return s.pair + ": " + s.direction + " · spike " + s.spikeLikelihood +
            " (" + s.spikeConfirmations + "/" + s.spikeAvailableChecks + " available checks) · " + factors;
        });
        const directional = available.filter(s => s.direction === "BUY" || s.direction === "SELL");
        const buys = directional.filter(s => s.direction === "BUY").length;
        const sells = directional.filter(s => s.direction === "SELL").length;
        const consensus = buys > sells ? "BUY BIAS" : sells > buys ? "SELL BIAS" : "MIXED / WAIT";
        await broadcast("📊 15-MIN PRE-NEWS SPIKE CHECK — " + event.currency,
          event.name + " releases in about " + Math.round(mins) + " minutes. Cross-market result: " + consensus +
          ". Spike likelihood is a confirmation grade, not a probability. Seven checks are reported separately; missing volume/cross-market data is not counted. " +
          lines.join(" · ") +
          ". Pre-news direction is not a prediction of the actual result or a trade instruction. Confirm spread, liquidity and risk.",
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
              if (after.length >= 2) {
                const firstOpen = num(after[0].open);
                const lastClose = num(after[after.length - 1].close);
                if (firstOpen && lastClose !== null) {
                  const pct = (lastClose - firstOpen) / firstOpen * 100;
                  reactionLines.push(pair + " " + (pct > 0 ? "UP" : pct < 0 ? "DOWN" : "FLAT") +
                    " " + pct.toFixed(3) + "%");
                } else reactionLines.push(pair + " reaction unavailable");
              } else reactionLines.push(pair + " waiting for completed post-release candles");
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
      process.env.SPIKE_TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_API_KEY || "";
    let economic = { highImpactEvents: 0, oneHourAlerts: 0, preNewsBiasAlerts: 0, postNewsResults: 0, errors: [] };
    try { economic = await sendEconomicNews(apiKey); }
    catch (error) { economic.errors.push("Calendar: " + error.message); console.error("DAGBO calendar monitor:", error.message); }
    let breaking = { checked: 0, sent: 0 };
    try { breaking = await sendBreakingNews(); }
    catch (error) { console.error("DAGBO breaking news:", error.message); }
    const summary = { success: true, checkedAt: new Date().toISOString(), economic, breaking,
      spikePairs: PAIRS, spikeApiKeyConfigured: !!apiKey,
      fmpApiKeyConfigured: !!(process.env.FMP_API_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY) };
    await redis.set("dagbo:news:monitor:last", JSON.stringify(summary), { ex: 60 * 60 * 24 * 7 });
    return summary;
  } finally {
    await redis.del(lockKey);
  }
}
module.exports = { runNewsMonitor, validAuth };

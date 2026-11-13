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

function priceMetrics(candles) {
  const rows = (candles || []).map(c => ({
    open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close),
    volume: num(c.volume), time: candleTime(c)
  })).filter(c => [c.open,c.high,c.low,c.close].every(Number.isFinite) && c.close > 0);
  if (rows.length < 22) return null;
  const last = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const changePct = (last.close - rows[rows.length - 3].open) / rows[rows.length - 3].open * 100;
  const closes = rows.map(c => c.close);
  const ema = (values, period) => {
    const k = 2 / (period + 1);
    return values.slice(0, period).reduce((a,b) => a + b, 0) / period +
      values.slice(period).reduce((a,b) => a + b * k - a * k, 0) * 0;
  };
  const calcEma = (values, period) => {
    let value = values.slice(0, period).reduce((a,b) => a + b, 0) / period;
    for (const v of values.slice(period)) value = v * (2 / (period + 1)) + value * (1 - 2 / (period + 1));
    return value;
  };
  const ranges = rows.slice(-21, -1).map(c => c.high - c.low).filter(v => v > 0);
  const avgRange = ranges.length ? ranges.reduce((a,b) => a+b,0) / ranges.length : 0;
  const lastRange = last.high - last.low;
  const ratio = avgRange > 0 ? lastRange / avgRange : null;
  const recent5 = rows.slice(-6, -1).map(c => c.high - c.low);
  const prior15 = rows.slice(-21, -6).map(c => c.high - c.low);
  const mean = values => values.length ? values.reduce((a,b) => a+b,0) / values.length : null;
  const compressionRatio = mean(recent5) && mean(prior15) ? mean(recent5) / mean(prior15) : null;
  const atr = mean(rows.slice(-15, -1).map(c => c.high - c.low));
  const priorLevels = rows.slice(-21, -1);
  const swingHigh = Math.max(...priorLevels.map(c => c.high));
  const swingLow = Math.min(...priorLevels.map(c => c.low));
  const liquidityDistance = atr > 0 ? Math.min(Math.abs(last.close - swingHigh), Math.abs(last.close - swingLow)) / atr : null;
  const volumeRows = rows.slice(-21, -1).map(c => c.volume).filter(v => v !== null && v > 0);
  const avgVolume = mean(volumeRows);
  const volumeRatio = avgVolume && last.volume !== null && last.volume > 0 ? last.volume / avgVolume : null;
  const direction = changePct > 0 ? "BUY" : changePct < 0 ? "SELL" : "WAIT";
  const trend = calcEma(closes, 9) > calcEma(closes, 21) ? "BUY" :
    calcEma(closes, 9) < calcEma(closes, 21) ? "SELL" : "WAIT";
  return {
    direction, changePct, trend,
    volatilityRatio: ratio,
    compressionRatio,
    compression: compressionRatio === null ? "PENDING" : compressionRatio <= 0.75 ? "PASS" : "FAIL",
    volatility: ratio === null ? "PENDING" : ratio >= 0.5 && ratio <= 2.5 ? "PASS" : "FAIL",
    liquidityDistance,
    liquidity: liquidityDistance === null ? "PENDING" : liquidityDistance <= 0.35 ? "PASS" : "FAIL",
    volumeRatio,
    volumeDirection: last.close > last.open ? "BUY" : last.close < last.open ? "SELL" : "WAIT",
    volume: volumeRatio === null ? "PENDING" : volumeRatio >= 1.25 ? "PASS" : "FAIL",
    latestClose: last.close,
    previousClose: previous.close
  };
}
async function fetchSpread(pair, apiKey) {
  const symbol = SYMBOLS[pair];
  const url = "https://api.twelvedata.com/quote?symbol=" + encodeURIComponent(symbol) +
    "&apikey=" + encodeURIComponent(apiKey);
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.status === "error") return { status: "PENDING", reason: "spread data unavailable" };
  const bid = num(data.bid), ask = num(data.ask);
  if (bid === null || ask === null || bid <= 0 || ask < bid) {
    return { status: "PENDING", reason: "provider did not return bid/ask" };
  }
  const spread = ask - bid;
  const limits = { GBPUSD: 0.00025, EURUSD: 0.00020, GBPJPY: 0.035, XAUUSD: 0.80 };
  return { status: spread <= limits[pair] ? "PASS" : "FAIL", spread };
}
function currencyStrength(currency, metrics) {
  if (currency === "GLOBAL") return "PENDING";
  const votes = [];
  for (const [pair, metric] of Object.entries(metrics)) {
    if (!metric || metric.direction === "WAIT") continue;
    let sign = metric.direction === "BUY" ? 1 : -1;
    if (currency === "USD") {
      if (["GBPUSD","EURUSD","XAUUSD"].includes(pair)) sign *= -1;
      else if (pair === "GBPJPY") continue;
    } else if (currency === "GBP" && ["GBPUSD","GBPJPY"].includes(pair)) {
      // GBP is the base currency in both pairs.
    } else if (currency === "EUR" && pair === "EURUSD") {
      // EUR is the base currency.
    } else if (currency === "JPY" && pair === "GBPJPY") {
      sign *= -1;
    } else continue;
    votes.push(sign);
  }
  if (!votes.length) return "PENDING";
  const total = votes.reduce((a,b) => a+b, 0);
  return total > 0 ? "STRONGER" : total < 0 ? "WEAKER" : "MIXED";
}
function numericSurprise(actual, forecast) {
  const a = parseFloat(String(actual).replace(/,/g, ""));
  const f = parseFloat(String(forecast).replace(/,/g, ""));
  if (!Number.isFinite(a) || !Number.isFinite(f)) return "PENDING";
  return a > f ? "ABOVE FORECAST" : a < f ? "BELOW FORECAST" : "IN LINE";
}
function sessionActivity(at) {
  const parts = zone => {
    const values = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const out = {};
    for (const p of values) out[p.type] = p.value;
    return Number(out.hour) * 60 + Number(out.minute);
  };
  const london = parts("Europe/London"), newYork = parts("America/New_York");
  const londonOpen = london >= 8 * 60 && london < 17 * 60;
  const newYorkOpen = newYork >= 8 * 60 && newYork < 17 * 60;
  return { active: londonOpen || newYorkOpen, label: londonOpen && newYorkOpen ? "London–New York overlap" :
    londonOpen ? "London session" : newYorkOpen ? "New York session" : "Major sessions quiet" };
}
function directionAnalysis(event, metrics) {
  const valid = Object.values(metrics).filter(Boolean);
  const aligned = valid.filter(m => m.direction !== "WAIT" && m.direction === m.trend);
  const buys = aligned.filter(m => m.direction === "BUY").length;
  const sells = aligned.filter(m => m.direction === "SELL").length;
  const count = aligned.length;
  const agreement = count ? Math.max(buys, sells) / count : 0;
  const direction = count >= 2 && agreement >= 0.67 ? (buys > sells ? "UP" : "DOWN") : "WAIT";
  const strength = currencyStrength(event.currency, metrics);
  const score = count >= 2 ? Math.round(agreement * 100) : null;
  return { direction, agreementScore: score, alignedMarkets: count, currencyStrength: strength,
    reason: direction === "WAIT" ? "Fewer than two aligned markets or directional disagreement" :
      count + " markets agree on 15-minute price action and trend" };
}
function spikeLikelihood(event, metrics, at) {
  const valid = Object.values(metrics).filter(Boolean);
  const values = Object.values(metrics);
  const compression = values.some(m => m && m.compression === "PASS") ? "PASS" :
    values.length && values.every(m => !m || m.compression === "FAIL") ? "FAIL" : "PENDING";
  const liquidity = values.some(m => m && m.liquidity === "PASS") ? "PASS" :
    values.length && values.every(m => !m || m.liquidity === "FAIL") ? "FAIL" : "PENDING";
  const volume = values.some(m => m && m.volume === "PASS") ? "PASS" :
    values.length && values.every(m => !m || m.volume === "FAIL") ? "FAIL" : "PENDING";
  const directional = valid.filter(m => m.direction !== "WAIT");
  const up = directional.filter(m => m.direction === "BUY").length;
  const down = directional.filter(m => m.direction === "SELL").length;
  const relatedAgreement = directional.length >= 2 && Math.max(up, down) / directional.length >= 0.67;
  const session = sessionActivity(at);
  const surprise = numericSurprise(event.actual, event.forecast);
  const factors = [
    { name: "Economic calendar / news", weight: 20, status: event.impact === "high" ? "PASS" : "FAIL",
      detail: event.impact === "high" ? "High-impact event scheduled" : "No high-impact catalyst" },
    { name: "Volatility compression", weight: 20, status: compression,
      detail: compression === "PENDING" ? "Candle history unavailable" : "Recent candle ranges compared with prior range" },
    { name: "Liquidity / stop clusters", weight: 15, status: liquidity,
      detail: liquidity === "PENDING" ? "Swing-level data unavailable" : "Price proximity to recent swing highs/lows (proxy)" },
    { name: "Volume / order-flow proxy", weight: 15, status: volume,
      detail: volume === "PENDING" ? "Provider volume unavailable" : "Tick/quote volume expansion proxy; not global FX order flow" },
    { name: "Cross-market confirmation", weight: 15, status: relatedAgreement ? "PASS" : directional.length < 2 ? "PENDING" : "FAIL",
      detail: directional.length < 2 ? "Not enough related market feeds" : "Agreement across available affected pairs; DXY/yields not connected" },
    { name: "Session volatility", weight: 10, status: session.active ? "PASS" : "FAIL", detail: session.label },
    { name: "Implied volatility", weight: 5, status: "PENDING", detail: "Options-implied volatility feed is not connected" }
  ];
  const known = factors.filter(f => f.status !== "PENDING");
  const earned = known.filter(f => f.status === "PASS").reduce((sum,f) => sum + f.weight, 0);
  const possible = known.reduce((sum,f) => sum + f.weight, 0);
  const score = possible ? Math.round(earned / possible * 100) : null;
  const coverage = Math.round(known.reduce((sum,f) => sum + f.weight, 0) / 100 * 100);
  const label = score === null || coverage < 50 ? "INSUFFICIENT DATA" :
    score >= 70 ? "HIGH SETUP" : score >= 45 ? "MODERATE SETUP" : "LOW SETUP";
  return { factors, score, coverage, label, passed: known.filter(f => f.status === "PASS").length,
    failed: known.filter(f => f.status === "FAIL").length, pending: factors.length - known.length };
}
function formatFactors(report) {
  return report.factors.map((f,i) => (i+1) + ". " + f.name + ": " + f.status + " (" + f.detail + ")").join(" | ");
}
function formatDirection(report) {
  return "Direction: " + report.direction + (report.agreementScore === null ? " (not enough data)" :
    " (directional agreement " + report.agreementScore + "% across " + report.alignedMarkets + " markets)") +
    ". " + report.reason + ". Currency strength: " + report.currencyStrength;
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

    // Seven-check pre-news analysis. Actual-vs-forecast remains pending until release.
    if (mins <= 20 && mins > 10 && apiKey && pairs.length) {
      const key = "dagbo:news:pre-bias:" + id;
      if (!(await redis.get(key))) {
        const snapshots = await Promise.all(pairs.map(async pair => {
          try {
            const candles = await fetchCandles(pair, "15min", apiKey, 30);
            const completed = candles.filter(c => candleTime(c) + 15 * 60 * 1000 <= event.date.getTime() - 10 * 60 * 1000);
            return { pair, metric: priceMetrics(completed) };
          } catch (error) {
            result.errors.push(pair + " pre-news: " + error.message);
            return { pair, metric: null };
          }
        }));
        const metrics = Object.fromEntries(snapshots.map(s => [s.pair, s.metric]));
        const likelihood = spikeLikelihood(event, metrics, new Date());
        const direction = directionAnalysis(event, metrics);
        const lines = snapshots.map(s => s.pair + ": " + (s.metric ? s.metric.direction + " " + s.metric.changePct.toFixed(3) + "%" : "WAIT / data unavailable"));
        const scoreText = likelihood.score === null ? "Score unavailable" : likelihood.score + "/100 setup score";
        await broadcast("📊 SPIKE " + scoreText + " · " + direction.direction,
          event.name + " in about " + Math.round(mins) + " minutes. SPIKE LIKELIHOOD: " + likelihood.label +
          " (" + scoreText + ", data coverage " + likelihood.coverage + "%). " +
          "SPIKE DIRECTION: " + formatDirection(direction) + ". " + formatFactors(likelihood) +
          ". Pair readings: " + lines.join("; ") + ". This is a model setup score, not a calibrated probability or guaranteed prediction. Pending data is excluded; do not trade solely on this alert.",
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
        // Recheck the seven confirmations after release using the latest completed 15m data.
        const postMetricsEntries = await Promise.all(pairs.map(async pair => {
          try {
            const candles = await fetchCandles(pair, "15min", apiKey, 30);
            const completed = candles.filter(c => candleTime(c) + 15 * 60 * 1000 <= now);
            return [pair, priceMetrics(completed)];
          } catch (error) {
            result.errors.push(pair + " post-news 15m: " + error.message);
            return [pair, null];
          }
        }));
        const postMetrics = Object.fromEntries(postMetricsEntries);
        const postLikelihood = spikeLikelihood(event, postMetrics, new Date());
        const postDirection = directionAnalysis(event, postMetrics);
        const actual = event.actual || "Not yet reported by calendar";
        const forecast = event.forecast || "not supplied";
        const previous = event.previous || "not supplied";
        await broadcast("⚡ POST-NEWS REVIEW — " + event.currency,
          event.name + " · Actual: " + actual + " · Forecast: " + forecast + " · Previous: " + previous +
          ". SPIKE LIKELIHOOD REVIEW: " + (postLikelihood.score === null ? "unavailable" : postLikelihood.score + "/100 setup score") +
          " · " + postLikelihood.label + " · " + postLikelihood.coverage + "% data coverage. " +
          "SPIKE DIRECTION: " + formatDirection(postDirection) + ". " + formatFactors(postLikelihood) +
          ". Price reaction since release: " + (reactionLines.join(" · ") || "market data unavailable") +
          ". This is a post-event review, not a promise of another spike. Missing data is never counted as a pass.",
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
      process.env.SPIKE_TWELVE_DATA_API_KEY ||
      process.env.TWELVE_DATA_SPIKE_API_KEY || "";
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

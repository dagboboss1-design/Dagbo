const webpush = require("web-push");
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const BLS_CALENDAR_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const EASTERN_TZ = "America/New_York";
const NEWS_LOOKAHEAD_DAYS = 75;

function calculateBias(dxyChange, goldChange) {
  let score = Math.round(50 + (dxyChange * -10) + (goldChange * 5));
  score = Math.max(30, Math.min(70, score));
  if (score >= 58) return { action: "BUY GOLD", color: "🟢", score };
  if (score <= 42) return { action: "SELL GOLD", color: "🔴", score };
  return { action: "WAIT", color: "🟡", score };
}


/**
 * Synthetic DXY estimate using the ICE U.S. Dollar Index basket formula.
 * This is calculated from component FX quotes; it is NOT an official ICE
 * index feed or a guaranteed real-time DXY price.
 */
function calculateDxyEstimate(q) {
  const required = ["EUR/USD", "USD/JPY", "GBP/USD", "USD/CAD", "USD/SEK", "USD/CHF"];
  for (const symbol of required) {
    const row = q[symbol];
    if (!row || !Number.isFinite(row.current) || !Number.isFinite(row.open) ||
        row.current <= 0 || row.open <= 0) {
      throw new Error(`Missing or invalid quote for ${symbol}`);
    }
  }

  const indexValue = (p) => 50.14348112 *
    Math.pow(p["EUR/USD"], -0.576) *
    Math.pow(p["USD/JPY"], 0.136) *
    Math.pow(p["GBP/USD"], -0.119) *
    Math.pow(p["USD/CAD"], 0.091) *
    Math.pow(p["USD/SEK"], 0.042) *
    Math.pow(p["USD/CHF"], 0.036);

  const current = {};
  const open = {};
  for (const symbol of required) {
    current[symbol] = q[symbol].current;
    open[symbol] = q[symbol].open;
  }
  const currentIndex = indexValue(current);
  const openIndex = indexValue(open);
  return {
    current: currentIndex,
    open: openIndex,
    changePct: ((currentIndex - openIndex) / openIndex) * 100
  };
}

async function sendPush(title, body, tag) {
  const payload = JSON.stringify({ title, body, url: "/boss1.html", tag });
  const ids = await redis.smembers("dagbo:push:subscriptions");
  let sent = 0;

  for (const id of ids) {
    const stored = await redis.get(`dagbo:push:sub:${id}`);
    if (!stored) continue;
    const sub = typeof stored === "string" ? JSON.parse(stored) : stored;

    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      if ([404, 410].includes(err.statusCode)) {
        await redis.del(`dagbo:push:sub:${id}`);
        await redis.srem("dagbo:push:subscriptions", id);
      }
    }
  }
  return sent;
}

// Convert a wall-clock time in New York into a real UTC instant.
// Intl time-zone data applies EST/EDT automatically.
function easternTimeToUtc(year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;

  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: EASTERN_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(guess));

    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    const represented = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour), Number(p.minute), 0
    );
    guess += target - represented;
  }
  return new Date(guess);
}

function unfoldIcs(text) {
  return text.replace(/\r?\n[ \t]/g, "");
}

function parseBlsEvents(icsText) {
  const lines = unfoldIcs(icsText).split(/\r?\n/);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current && current.start && current.name) {
        const name = current.name.toLowerCase();
        let eventName = null;
        if (name.includes("consumer price index")) eventName = "CPI";
        if (name.includes("employment situation")) eventName = "NFP";

        if (eventName) {
          const match = current.start.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
          if (match) {
            const [, ys, ms, ds, hs, mins, secs, isUtc] = match;
            const year = Number(ys), month = Number(ms), day = Number(ds);
            // BLS releases are scheduled for 08:30 New York time.
            // If the feed supplies a UTC timestamp, respect it exactly.
            const date = isUtc
              ? new Date(Date.UTC(year, month - 1, day, Number(hs || 0), Number(mins || 0), Number(secs || 0)))
              : easternTimeToUtc(year, month, day, hs ? Number(hs) : 8, hs ? Number(mins) : 30);
            if (!Number.isNaN(date.getTime())) events.push({ name: eventName, date });
          }
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("SUMMARY:")) current.name = line.slice(8).trim();
    if (line.startsWith("DTSTART")) current.start = line.slice(line.indexOf(":") + 1).trim();
  }
  return events;
}

async function getScheduledNews(now) {
  const response = await fetch(BLS_CALENDAR_URL, {
    headers: { "User-Agent": "DAGBO-SIGNAL-News-Alerts/1.0" }
  });
  if (!response.ok) throw new Error(`BLS calendar returned HTTP ${response.status}`);

  const events = parseBlsEvents(await response.text());
  const horizon = now.getTime() + NEWS_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
  return events
    .filter(event => event.date.getTime() >= now.getTime() - 5 * 60 * 1000 &&
                     event.date.getTime() <= horizon)
    .sort((a, b) => a.date - b.date);
}

async function claimOnce(key) {
  // Prevent repeat pushes when the cron endpoint runs more than once in a window.
  const result = await redis.set(key, "1", { nx: true, ex: 7 * 24 * 60 * 60 });
  return result === "OK";
}

module.exports = async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;
    const now = new Date();
    const events = await getScheduledNews(now);

    if (!events.length) {
      return res.status(200).json({ message: "No scheduled CPI/NFP release found in the BLS calendar window." });
    }

    // First check for an event that has just happened (1–4 minutes ago).
    const justReleased = events
      .filter(event => {
        const minutesSince = (now.getTime() - event.date.getTime()) / 60000;
        return minutesSince >= 1 && minutesSince <= 4;
      })
      .sort((a, b) => b.date - a.date)[0];

    if (justReleased) {
      if (!API_KEY) return res.status(500).json({ error: "Missing TWELVE_DATA_API_KEY" });

      const spikeKey = `dagbo:cron:spike:${justReleased.name}:${justReleased.date.toISOString()}`;
      if (!(await claimOnce(spikeKey))) {
        return res.status(200).json({ message: "Post-news alert already checked for this release." });
      }

      const quoteUrl = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&outputsize=2&apikey=${encodeURIComponent(API_KEY)}`;
      const goldResponse = await fetch(quoteUrl);
      const gold = await goldResponse.json();

      if (gold.values && gold.values.length) {
        // Twelve Data returns newest candle first. Use the latest completed candle.
        const candle = gold.values[0];
        const open = Number(candle.open);
        const close = Number(candle.close);
        const changePct = open > 0 ? ((close - open) / open) * 100 : 0;

        if (changePct >= 0.30) {
          await sendPush("🚀 SPIKE BUY", `GOLD 1-minute candle rose +${changePct.toFixed(2)}% after ${justReleased.name}. High volatility — confirm before trading.`, "dagbo-spike-buy");
          return res.status(200).json({ sent: "buy spike", changePct });
        }
        if (changePct <= -0.30) {
          await sendPush("🔻 SPIKE SELL", `GOLD 1-minute candle fell ${changePct.toFixed(2)}% after ${justReleased.name}. High volatility — confirm before trading.`, "dagbo-spike-sell");
          return res.status(200).json({ sent: "sell spike", changePct });
        }
      }
      return res.status(200).json({ message: "Post-news window checked; no qualifying gold spike.", event: justReleased.name });
    }

    const nextEvent = events.find(event => event.date.getTime() > now.getTime());
    if (!nextEvent) return res.status(200).json({ message: "No upcoming CPI/NFP release in the calendar window." });

    const minsToNews = (nextEvent.date.getTime() - now.getTime()) / 60000;
    const eventId = `${nextEvent.name}:${nextEvent.date.toISOString()}`;

    if (minsToNews > 59 && minsToNews <= 61) {
      if (await claimOnce(`dagbo:cron:1hr:${eventId}`)) {
        await sendPush("⏰ NEWS IN 1 HOUR", `${nextEvent.name} releases in about 60 minutes. Prepare and manage risk.`, "dagbo-1hr");
        return res.status(200).json({ sent: "1hr alert", event: nextEvent.name });
      }
    }

    if (minsToNews > 14 && minsToNews <= 16) {
      if (!(await claimOnce(`dagbo:cron:15min:${eventId}`))) {
        return res.status(200).json({ message: "15-minute alert already sent.", event: nextEvent.name });
      }
      if (!API_KEY) return res.status(500).json({ error: "Missing TWELVE_DATA_API_KEY" });

      const symbols = ["EUR/USD", "USD/JPY", "GBP/USD", "USD/CAD", "USD/SEK", "USD/CHF", "XAU/USD"];
      const quoteResults = await Promise.all(symbols.map(async (symbol) => {
        const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(API_KEY)}`;
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok || data.status === "error" || !data.open || !data.close) {
          throw new Error(`Twelve Data quote unavailable for ${symbol}: ${data.message || response.status}`);
        }
        return [symbol, { open: Number(data.open), current: Number(data.close) }];
      }));
      const quotes = Object.fromEntries(quoteResults);
      const dxyEstimate = calculateDxyEstimate(quotes);
      const gold = quotes["XAU/USD"];
      const goldChange = ((gold.current - gold.open) / gold.open) * 100;
      const bias = calculateBias(dxyEstimate.changePct, goldChange);

      await sendPush(
        "🎯 15-MIN NEWS BIAS",
        `${nextEvent.name} in about 15 minutes. Calculated USD-basket estimate: ${dxyEstimate.current.toFixed(2)} (${dxyEstimate.changePct >= 0 ? "+" : ""}${dxyEstimate.changePct.toFixed(3)}%). Gold: ${goldChange >= 0 ? "+" : ""}${goldChange.toFixed(3)}%. Indicative bias: ${bias.color} ${bias.action} (${bias.score}/100). Basket estimate, not official live ICE DXY.`,
        "dagbo-bias"
      );
      return res.status(200).json({
        sent: "bias alert",
        event: nextEvent.name,
        dxyEstimate: {
          value: Number(dxyEstimate.current.toFixed(4)),
          changePct: Number(dxyEstimate.changePct.toFixed(4)),
          label: "Calculated USD basket estimate (ICE DXY formula; not official live DXY)"
        },
        goldChangePct: Number(goldChange.toFixed(4)),
        bias
      });
        }
      }
      return res.status(502).json({ error: "Twelve Data did not return usable EUR/USD and XAU/USD quotes." });
    }

    return res.status(200).json({
      message: "Waiting for the next alert window.",
      nextEvent: nextEvent.name,
      releaseTimeUtc: nextEvent.date.toISOString(),
      minutesToNews: Number(minsToNews.toFixed(1))
    });
  } catch (error) {
    console.error("DAGBO cron error:", error);
    return res.status(502).json({ error: "Could not process the official BLS news calendar.", detail: error.message });
  }
};

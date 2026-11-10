const webpush = require("web-push");
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});
const BLS_CALENDAR_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const EASTERN_TZ = "America/New_York";
const LOOKAHEAD_DAYS = 75;

function authorized(req) {
  const secret = process.env.CRON_SECRET || process.env.SIGNAL_PUSH_SECRET;
  const supplied = req.headers.authorization || "";
  if (!secret) return false;
  const a = Buffer.from(supplied), b = Buffer.from("Bearer " + secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function calculateBias(dxyChange, goldChange) {
  let score = Math.round(50 + dxyChange * -10 + goldChange * 5);
  score = Math.max(30, Math.min(70, score));
  if (score >= 58) return { action: "BUY GOLD", color: "🟢", score };
  if (score <= 42) return { action: "SELL GOLD", color: "🔴", score };
  return { action: "WAIT", color: "🟡", score };
}
function calculateDxyEstimate(q) {
  const required = ["EUR/USD","USD/JPY","GBP/USD","USD/CAD","USD/SEK","USD/CHF"];
  for (const symbol of required) {
    const row = q[symbol];
    if (!row || !Number.isFinite(row.current) || !Number.isFinite(row.open) || row.current <= 0 || row.open <= 0) {
      throw new Error("Missing or invalid quote for " + symbol);
    }
  }
  const index = p => 50.14348112 *
    Math.pow(p["EUR/USD"], -0.576) * Math.pow(p["USD/JPY"], 0.136) *
    Math.pow(p["GBP/USD"], -0.119) * Math.pow(p["USD/CAD"], 0.091) *
    Math.pow(p["USD/SEK"], 0.042) * Math.pow(p["USD/CHF"], 0.036);
  const current = {}, open = {};
  required.forEach(s => { current[s] = q[s].current; open[s] = q[s].open; });
  const currentValue = index(current), openValue = index(open);
  return { current: currentValue, open: openValue, changePct: (currentValue - openValue) / openValue * 100 };
}
function easternTimeToUtc(year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: EASTERN_TZ, year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit", hourCycle:"h23"
    }).formatToParts(new Date(guess));
    const p = Object.fromEntries(parts.map(x => [x.type,x.value]));
    const represented = Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),0);
    guess += target - represented;
  }
  return new Date(guess);
}
function unfoldIcs(text) { return text.replace(/\r?\n[ \t]/g, ""); }
function parseBlsEvents(ics) {
  const events = [];
  let current = null;
  for (const line of unfoldIcs(ics).split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") { current = {}; continue; }
    if (line === "END:VEVENT") {
      if (current && current.start && current.name) {
        const label = current.name.toLowerCase();
        const name = label.includes("consumer price index") ? "CPI" :
          label.includes("employment situation") ? "NFP" : null;
        const m = current.start.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
        if (name && m) {
          const [, y, mo, d, h, mi, sec, utc] = m;
          const date = utc
            ? new Date(Date.UTC(+y,+mo-1,+d,+(h||0),+(mi||0),+(sec||0)))
            : easternTimeToUtc(+y,+mo,+d,h ? +h : 8,h ? +mi : 30);
          if (!Number.isNaN(date.getTime())) events.push({ name, date });
        }
      }
      current = null; continue;
    }
    if (!current) continue;
    if (line.startsWith("SUMMARY:")) current.name = line.slice(8).trim();
    if (line.startsWith("DTSTART")) current.start = line.slice(line.indexOf(":")+1).trim();
  }
  return events;
}
async function sendPush(title, body, tag, url) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error("VAPID keys are not configured");
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const ids = await redis.smembers("dagbo:push:subscriptions");
  let sent = 0, failed = 0;
  for (const id of ids) {
    const key = "dagbo:push:sub:" + id;
    const raw = await redis.get(key);
    if (!raw) { await redis.srem("dagbo:push:subscriptions", id); continue; }
    try {
      const sub = typeof raw === "string" ? JSON.parse(raw) : raw;
      await webpush.sendNotification(sub, JSON.stringify({title,body,tag,url:url||"/news.html"}), {TTL:900,urgency:"high"});
      sent++;
    } catch (err) {
      failed++;
      if ([404,410].includes(err.statusCode)) {
        await redis.del(key); await redis.srem("dagbo:push:subscriptions",id);
      } else console.error("DAGBO news push error:",err.message);
    }
  }
  return {sent,failed};
}
async function getHighImpactEvents(now) {
  const horizon = now.getTime() + 7 * 24 * 60 * 60 * 1000;
  let events = [];
  try {
    const response = await fetch(FF_CALENDAR_URL, { headers: { "User-Agent": "DAGBO-SIGNAL-Economic-Alerts/1.0" } });
    if (!response.ok) throw new Error("Forex Factory calendar feed returned HTTP " + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Calendar feed did not return an event list");
    events = rows.filter(row => String(row.impact || "").toLowerCase() === "high")
      .map(row => ({
        name: String(row.title || "High-impact economic event"),
        currency: String(row.country || "GLOBAL").toUpperCase(),
        date: new Date(row.date),
        impact: "High",
        forecast: row.forecast || "",
        previous: row.previous || "",
        actual: row.actual || ""
      }))
      .filter(e => !Number.isNaN(e.date.getTime()));
  } catch (error) {
    console.error("DAGBO calendar feed fallback:", error.message);
    const response = await fetch(BLS_CALENDAR_URL, { headers: { "User-Agent": "DAGBO-SIGNAL-News-Alerts/1.0" } });
    if (!response.ok) throw new Error("Both economic calendar sources failed");
    events = parseBlsEvents(await response.text()).map(e => ({
      ...e, currency: "USD", impact: "High", forecast: "", previous: "", actual: ""
    }));
  }
  const unique = new Map();
  for (const event of events) {
    if (event.date.getTime() < now.getTime() - 6 * 60 * 1000 || event.date.getTime() > horizon) continue;
    const id = [event.currency, event.name, event.date.toISOString()].join(":");
    unique.set(id, { ...event, id });
  }
  return Array.from(unique.values()).sort((a,b) => a.date - b.date);
}

async function fetchQuote(symbol, apiKey) {
  const url = "https://api.twelvedata.com/quote?symbol=" + encodeURIComponent(symbol) + "&apikey=" + encodeURIComponent(apiKey);
  const response = await fetch(url);
  const data = await response.json();
  const open = Number(data.open), current = Number(data.close);
  if (!response.ok || data.status === "error" || !Number.isFinite(open) || !Number.isFinite(current) || open <= 0 || current <= 0) {
    throw new Error("Quote unavailable for " + symbol + ": " + (data.message || response.status));
  }
  return {open,current};
}
async function claim(key) {
  return (await redis.set(key,"1",{nx:true,ex:7*24*60*60})) === "OK";
}

module.exports = async function handler(req,res) {
  if (!authorized(req)) return res.status(401).json({error:"Unauthorized"});
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({error:"Method not allowed"});
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({error:"Missing TWELVE_DATA_API_KEY"});
  const lock = "dagbo:cron:news:lock";
  const acquired = await redis.set(lock,String(Date.now()),{nx:true,ex:4*60});
  if (acquired !== "OK") return res.status(200).json({skipped:true,reason:"News alert check already running"});

  try {
    const now = new Date();
    const events = await getHighImpactEvents(now);
    const released = events.filter(e => {
      const mins = (now.getTime() - e.date.getTime()) / 60000;
      return mins >= 0 && mins <= 6;
    }).sort((a,b) => b.date - a.date)[0];

    if (released) {
      const releaseKey = "dagbo:news:released:" + encodeURIComponent(released.id);
      if (!(await redis.get(releaseKey))) {
        let detail = released.currency + " high-impact event: " + released.name + ".";
        if (released.actual) detail += " Actual " + released.actual + ".";
        if (released.forecast) detail += " Forecast " + released.forecast + ".";
        if (released.previous) detail += " Previous " + released.previous + ".";
        let title = "🚨 " + released.currency + " NEWS RELEASED";
        if (released.currency === "USD") {
          try {
            const candleUrl = "https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&outputsize=2&apikey=" + encodeURIComponent(apiKey);
            const response = await fetch(candleUrl);
            const data = await response.json();
            if (response.ok && data.status !== "error" && Array.isArray(data.values) && data.values.length) {
              const candle = data.values[0];
              const open = Number(candle.open), close = Number(candle.close);
              const pct = open > 0 ? (close-open)/open*100 : 0;
              if (Math.abs(pct) >= 0.30) {
                title = pct > 0 ? "🚀 POST-NEWS GOLD SPIKE UP" : "🔻 POST-NEWS GOLD SPIKE DOWN";
                detail += " Gold's latest 1-minute candle moved " + (pct>0?"+":"") + pct.toFixed(2) + "%. Confirm price and spread before trading.";
              }
            }
          } catch (e) { console.error("Post-news gold check failed:",e.message); }
        }
        await sendPush(title,detail,"news-release-" + released.currency,"/news.html");
        await claim(releaseKey);
        return res.status(200).json({sent:"economic release alert",event:released.name,currency:released.currency});
      }
    }

    const next = events.find(e => e.date.getTime() > now.getTime());
    if (!next) return res.status(200).json({message:"No upcoming high-impact event in the current calendar feed."});
    const mins = (next.date.getTime() - now.getTime()) / 60000;
    const id = next.id;

    if (mins >= 57 && mins <= 63) {
      const key = "dagbo:news:1hr:" + encodeURIComponent(id);
      if (!(await redis.get(key))) {
        await sendPush("⏰ " + next.currency + " NEWS IN 1 HOUR",
          next.name + " (" + next.currency + ") releases in about 60 minutes. Prepare and manage risk.",
          "news-1hr-" + next.currency,"/news.html");
        await claim(key);
        return res.status(200).json({sent:"1-hour alert",event:next.name,currency:next.currency});
      }
    }
    if (mins >= 12 && mins <= 18) {
      const key = "dagbo:news:15min:" + encodeURIComponent(id);
      if (!(await redis.get(key))) {
        if (next.currency === "USD") {
          const symbols = ["EUR/USD","USD/JPY","GBP/USD","USD/CAD","USD/SEK","USD/CHF","XAU/USD"];
          const rows = await Promise.all(symbols.map(async s => [s,await fetchQuote(s,apiKey)]));
          const q = Object.fromEntries(rows);
          const dxy = calculateDxyEstimate(q);
          const goldChange = (q["XAU/USD"].current-q["XAU/USD"].open)/q["XAU/USD"].open*100;
          const bias = calculateBias(dxy.changePct,goldChange);
          await sendPush("🎯 15-MIN USD NEWS BIAS",
            next.name + " in about 15 minutes. Calculated USD basket estimate " + dxy.current.toFixed(2) +
            " (" + (dxy.changePct>=0?"+":"") + dxy.changePct.toFixed(3) + "%). Gold " +
            (goldChange>=0?"+":"") + goldChange.toFixed(3) + "%. Indicative gold bias: " +
            bias.color + " " + bias.action + " (" + bias.score + "/100). Synthetic basket estimate, not official live ICE DXY.",
            "news-bias-usd","/news.html");
          await claim(key);
          return res.status(200).json({sent:"15-minute USD bias",event:next.name,currency:next.currency,bias});
        }
        await sendPush("🎯 " + next.currency + " NEWS IN 15 MIN",
          next.name + " (" + next.currency + ") releases in about 15 minutes. Check the affected currency pairs and reduce risk if needed.",
          "news-bias-" + next.currency,"/news.html");
        await claim(key);
        return res.status(200).json({sent:"15-minute event alert",event:next.name,currency:next.currency});
      }
      return res.status(200).json({message:"15-minute alert already sent.",event:next.name});
    }
    return res.status(200).json({
      message:"Waiting for the next high-impact economic event.",
      event:next.name,currency:next.currency,releaseTimeUtc:next.date.toISOString(),
      minutesToNews:Number(mins.toFixed(1)),calendarEvents:events.length
    });
  } catch (error) {
    console.error("DAGBO news cron error:",error);
    return res.status(502).json({error:"Could not process BLS news alerts.",detail:error.message});
  } finally {
    await redis.del(lock);
  }
};

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
  const secret = process.env.DAGBO_CRON_SECRET || process.env.CRON_SECRET || process.env.SIGNAL_PUSH_SECRET;
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
  if (sent === 0) {
    throw new Error(
      ids.length === 0
        ? "No registered push subscriptions found. Enable notifications on the device in DAGBO Settings."
        : "No push notification was delivered (" + failed + " failed). The alert will be retried on the next scheduled run."
    );
  }
  return {sent,failed,total:ids.length};
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

async function fetch30mMove(symbol,apiKey){
 const url="https://api.twelvedata.com/time_series?symbol="+encodeURIComponent(symbol)+"&interval=1min&outputsize=35&apikey="+encodeURIComponent(apiKey);
 const response=await fetch(url),data=await response.json();
 if(!response.ok||data.status==="error"||!Array.isArray(data.values))throw new Error("30m candles unavailable for "+symbol+": "+(data.message||response.status));
 const rows=data.values.map(v=>({time:Date.parse(v.datetime),close:Number(v.close)})).filter(v=>Number.isFinite(v.time)&&Number.isFinite(v.close)&&v.close>0).sort((a,b)=>a.time-b.time);
 if(rows.length<2)throw new Error("Not enough candles for "+symbol);
 const latest=rows[rows.length-1],target=latest.time-1800000;let oldest=rows[0];
 for(const row of rows)if(Math.abs(row.time-target)<Math.abs(oldest.time-target))oldest=row;
 const span=(latest.time-oldest.time)/60000;if(span<25||span>36)throw new Error("Insufficient 30m history for "+symbol);
 return {symbol,changePct:(latest.close-oldest.close)/oldest.close*100};
}
const NEWS_PAIR_MAP={EUR:["EUR/USD","EUR/JPY","EUR/GBP"],GBP:["GBP/USD","GBP/JPY","EUR/GBP"],JPY:["USD/JPY","EUR/JPY","GBP/JPY"],AUD:["AUD/USD","AUD/JPY","AUD/NZD"],NZD:["NZD/USD","NZD/JPY","AUD/NZD"],CAD:["USD/CAD","CAD/JPY","AUD/CAD"],CHF:["USD/CHF","CHF/JPY","EUR/CHF"]};
async function calculateNewsBias(event,apiKey){
 const currency=String(event.currency||"").toUpperCase();if(!apiKey)return{action:"WAIT",confidence:"LOW",reason:"TWELVE_DATA_API_KEY is not configured."};
 if(currency==="USD"){
  const symbols=["EUR/USD","USD/JPY","GBP/USD","USD/CAD","USD/SEK","USD/CHF","XAU/USD"];
  const rows=await Promise.all(symbols.map(s=>fetch30mMove(s,apiKey))),m=Object.fromEntries(rows.map(r=>[r.symbol,r]));
  const weights={"EUR/USD":-0.576,"USD/JPY":0.136,"GBP/USD":-0.119,"USD/CAD":0.091,"USD/SEK":0.042,"USD/CHF":0.036};
  const dxy=Object.entries(weights).reduce((sum,[s,w])=>sum+w*Math.log(1+m[s].changePct/100)*100,0),gold=m["XAU/USD"].changePct,score=-dxy*.65+gold*.35;
  const action=score>.035?"BUY GOLD":score<-.035?"SELL GOLD":"WAIT",confidence=Math.abs(score)>=.12?"HIGH":Math.abs(score)>=.06?"MEDIUM":"LOW";
  const fx=["EUR/USD","GBP/USD","USD/JPY","USD/CHF","USD/CAD"].map(s=>s+" "+(m[s].changePct>=0?"+":"")+m[s].changePct.toFixed(3)+"%").join("; ");
  return{action,confidence,score:Number(score.toFixed(4)),evidence:"Previous 30m: synthetic DXY "+(dxy>=0?"+":"")+dxy.toFixed(3)+"%; Gold "+(gold>=0?"+":"")+gold.toFixed(3)+"%. Correlated pairs: "+fx};
 }
 const symbols=NEWS_PAIR_MAP[currency];if(!symbols)return{action:"WAIT",confidence:"LOW",reason:"No correlation basket configured for "+currency+"."};
 const rows=await Promise.all(symbols.map(s=>fetch30mMove(s,apiKey)));
 const strength=rows.reduce((sum,r)=>{const [base,quote]=r.symbol.split("/");return sum+r.changePct*(base===currency?1:quote===currency?-1:0);},0)/rows.length;
 const confidence=Math.abs(strength)>=.12?"HIGH":Math.abs(strength)>=.06?"MEDIUM":"LOW";
 const evidence=rows.map(r=>{const [base]=r.symbol.split("/");const dir=r.changePct>=0?"BUY":"SELL";return r.symbol+" "+dir+" ("+(r.changePct>=0?"+":"")+r.changePct.toFixed(3)+"%)";}).join("; ");
 return{action:Math.abs(strength)<.025?"WAIT":currency+" "+(strength>0?"STRONGER":"WEAKER"),confidence,score:Number(strength.toFixed(4)),evidence:"Previous 30m correlated basket: "+evidence};
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
  const lock = "dagbo:cron:news:lock";
  const acquired = await redis.set(lock,String(Date.now()),{nx:true,ex:4*60});
  if (acquired !== "OK") return res.status(200).json({skipped:true,reason:"News alert check already running"});

  try {
    const now = new Date();
    const events = await getHighImpactEvents(now);
    const releasedEvents = events.filter(e => {
      const mins = (now.getTime() - e.date.getTime()) / 60000;
      return mins >= 0 && mins <= 6;
    }).sort((a,b) => a.date - b.date);
    const releasedNow = [];
    for (const released of releasedEvents) {
      const releaseKey = "dagbo:news:released:" + encodeURIComponent(released.id);
      if (await redis.get(releaseKey)) continue;
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
      releasedNow.push({event:released.name,currency:released.currency});
    }
    if (releasedNow.length) return res.status(200).json({sent:"economic release alerts",events:releasedNow});

    const next = events.find(e => e.date.getTime() > now.getTime());
    if (!next) return res.status(200).json({message:"No upcoming high-impact event in the current calendar feed."});
    const mins = (next.date.getTime() - now.getTime()) / 60000;
    const id = next.id;

    if (mins >= 55 && mins <= 65) {
      const key = "dagbo:news:1hr:" + encodeURIComponent(id);
      if (!(await redis.get(key))) {
        await sendPush("⏰ " + next.currency + " NEWS IN 1 HOUR",
          next.name + " (" + next.currency + ") releases in about 60 minutes. Prepare and manage risk.",
          "news-1hr-" + next.currency,"/news.html");
        await claim(key);
        return res.status(200).json({sent:"1-hour alert",event:next.name,currency:next.currency});
      }
    }
    if (mins >= 10 && mins <= 20) {
      const key = "dagbo:news:15min:" + encodeURIComponent(id);
      if (!(await redis.get(key))) {
        let bias;
        try { bias = await calculateNewsBias(next,apiKey); }
        catch (e) { bias = {action:"WAIT",confidence:"LOW",reason:"30m correlation data unavailable: "+e.message}; }
        const evidence=bias.evidence||bias.reason||"Insufficient live correlated market data.";
        // Publish a short-lived news context candidate. Signals page may confirm it
        // only when its independent technical scan agrees; this is not a trade by itself.
        let newsCandidate = null;
        const currency = String(next.currency || "").toUpperCase();
        const targetMap = {
          EUR: { pair: "EURUSD", inverse: false },
          GBP: { pair: "GBPUSD", inverse: false },
          AUD: { pair: "AUDUSD", inverse: false },
          NZD: { pair: "NZDUSD", inverse: false },
          JPY: { pair: "USDJPY", inverse: true },
          CAD: { pair: "USDCAD", inverse: true },
          CHF: { pair: "USDCHF", inverse: true }
        };
        let candidatePair = null, candidateDirection = null;
        if (currency === "USD" && (bias.action === "BUY GOLD" || bias.action === "SELL GOLD")) {
          candidatePair = "XAUUSD";
          candidateDirection = bias.action === "BUY GOLD" ? "BUY" : "SELL";
        } else if (targetMap[currency]) {
          const stronger = bias.action === currency + " STRONGER";
          const weaker = bias.action === currency + " WEAKER";
          if (stronger || weaker) {
            candidatePair = targetMap[currency].pair;
            const currencyDirection = stronger ? "BUY" : "SELL";
            candidateDirection = targetMap[currency].inverse
              ? (currencyDirection === "BUY" ? "SELL" : "BUY")
              : currencyDirection;
          }
        }
        if (candidatePair && candidateDirection &&
            ["MEDIUM","HIGH"].includes(String(bias.confidence).toUpperCase())) {
          newsCandidate = {
            pair: candidatePair,
            direction: candidateDirection,
            action: candidateDirection + " " + candidatePair,
            event: next.name,
            currency,
            confidence: bias.confidence,
            evidence,
            source: "ECONOMIC_NEWS",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
          };
          await redis.set("dagbo:news:signal:latest", JSON.stringify(newsCandidate), { ex: 4 * 60 * 60 });
        }
        const title="🎯 15-MIN "+next.currency+" NEWS BIAS: "+bias.action;
        const body=next.name+" in about 15 minutes. Analysed the previous 30 minutes using 1-minute candles. "+evidence+
          " Bias: "+bias.action+". Confidence: "+bias.confidence+
          ". This is pre-news market context, not a guaranteed spike prediction. Wait for post-release confirmation and manage risk.";
        await sendPush(title,body,"news-bias-"+encodeURIComponent(id),
          newsCandidate ? "/signals.html" : "/news.html");
        await claim(key);
        return res.status(200).json({sent:"15-minute 30m correlation bias",event:next.name,currency:next.currency,bias});
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

const webpush = require("../lib/push-adapter.js");
const redis = require("../lib/redis.js");

// --- HELPERS ---
function firstFriday(year, mIdx){
  var d = new Date(year, mIdx, 1);
  var offset = (5 - d.getDay() + 7) % 7;
  return new Date(year, mIdx, 1 + offset, 13, 30, 0); // 13:30 WAT
}

function getHighNewsEvents() {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  var events = [];

  // Look ahead 3 months
  for (var i = 0; i < 3; i++) {
    // NFP (First Friday)
    var nfp = firstFriday(year, month);
    events.push({ name: 'NFP', date: nfp });

    // CPI (12th of month)
    var cpi = new Date(year, month, 12, 13, 30, 0);
    events.push({ name: 'CPI', date: cpi });

    // FOMC (18th of Jan, Mar, May, Jul, Sep, Nov)
    if ([0,2,4,6,8,10].includes(month)) {
      var fomc = new Date(year, month, 18, 19, 0, 0);
      events.push({ name: 'FOMC', date: fomc });
    }
    
    month++;
    if (month > 11) { month = 0; year++; }
  }
  return events;
}

async function sendPush(title, body, tag) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const payload = JSON.stringify({ title, body, url: "/boss1.html", tag });
  const ids = await redis.smembers("dagbo:push:subscriptions");
  for (const id of ids) {
    const stored = await redis.get(`dagbo:push:sub:${id}`);
    if (stored) {
      const sub = typeof stored === "string" ? JSON.parse(stored) : stored;
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if ([404, 410].includes(err.statusCode)) {
          await redis.del(`dagbo:push:sub:${id}`);
          await redis.srem("dagbo:push:subscriptions", id);
        }
      }
    }
  }
}

// --- MAIN CRON ROBOT ---
module.exports = async function handler(req, res) {
  // 1. SECURITY CHECK
  const supplied = req.headers.authorization || "";
  const secret = process.env.DAGBO_CRON_SECRET || process.env.CRON_SECRET || process.env.SIGNAL_PUSH_SECURITY || process.env.SIGNAL_PUSH_SECRET;
  const expected = `Bearer ${secret || ""}`;
  if (!secret || supplied !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const API_KEY = process.env.TWELVE_DATA_API_KEY;
  const now = new Date();
  const events = getHighNewsEvents();
  
  // Find the closest UPCOMING event
  let nextEvent = null;
  let minDiff = Infinity;
  
  events.forEach(e => {
    let diff = e.date - now; // milliseconds
    if (diff > -300000 && diff < minDiff) { // Allow -5 mins for post-news
      minDiff = diff;
      nextEvent = e;
    }
  });

  if (!nextEvent) return res.status(200).json({ message: "No upcoming news" });

  const minsToNews = minDiff / 60000; // Convert ms to minutes
  let actionTaken = "None";

  // --- TRIGGER 1: NEWS ALERT (30 Mins Before) ---
  if (minsToNews > 29 && minsToNews <= 31) {
    await sendPush("⚠️ NEWS ALERT", `${nextEvent.name} drops in 30 minutes! Close all trades.`, "dagbo-news-alert");
    actionTaken = "Sent 30m News Alert";
  }

  // --- TRIGGER 2: PRE-NEWS BIAS (15 Mins Before) ---
  else if (minsToNews > 14 && minsToNews <= 16) {
    if (!API_KEY) return res.status(500).json({ error: "No Twelve Data Key" });
    
    // Fetch EUR/USD (DXY proxy) and Gold
    let resEur = await fetch(`https://api.twelvedata.com/quote?symbol=EUR/USD&apikey=${API_KEY}`).then(r=>r.json());
    let resGold = await fetch(`https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${API_KEY}`).then(r=>r.json());

    if (resEur.close && resGold.close) {
      let dxyChange = ((parseFloat(resEur.close) - parseFloat(resEur.open)) / parseFloat(resEur.open)) * 100;
      let goldChange = ((parseFloat(resGold.close) - parseFloat(resGold.open)) / parseFloat(resGold.open)) * 100;
      
      // Calculate bias score (Base 50, DXY down = Gold Up)
      let score = Math.round(50 + (dxyChange * -10) + (goldChange * 5));
      if (score > 70) score = 70;
      if (score < 30) score = 30;

      let biasText = score >= 58 ? `BUY GOLD (${score}%)` : (score <= 42 ? `SELL GOLD (${score}%)` : `WAIT (${score}%)`);
      
      await sendPush("🎯 PRE-NEWS BIAS", `${nextEvent.name} in 15 mins. Bias: ${biasText}`, "dagbo-bias");
      actionTaken = "Sent Pre-News Bias";
    }
  }

  // --- TRIGGER 3: SPIKE SIGNAL (1 Min AFTER News) ---
  else if (minsToNews < -0.5 && minsToNews > -3) { // 30 secs to 3 mins after
    if (!API_KEY) return res.status(500).json({ error: "No Twelve Data Key" });
    
    // Fetch 1-min Gold candle
    let resGold = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&outputsize=2&apikey=${API_KEY}`).then(r=>r.json());
    
    if (resGold.values && resGold.values.length > 0) {
      let candle = resGold.values[0]; // Latest 1m candle
      let open = parseFloat(candle.open);
      let close = parseFloat(candle.close);
      let changePct = ((close - open) / open) * 100;

      if (changePct >= 0.30) {
        await sendPush("🚀 SPIKE DETECTED", `GOLD jumped +${changePct.toFixed(2)}%! STRONG BUY SPIKE.`, "dagbo-spike");
        actionTaken = "Sent BUY Spike";
      } else if (changePct <= -0.30) {
        await sendPush("🔻 SPIKE DETECTED", `GOLD dropped ${changePct.toFixed(2)}%! STRONG SELL SPIKE.`, "dagbo-spike");
        actionTaken = "Sent SELL Spike";
      }
    }
  }

  return res.status(200).json({ 
    success: true, 
    nextEvent: nextEvent.name, 
    timeToNews: minsToNews.toFixed(1) + " mins", 
    action: actionTaken 
  });
};
